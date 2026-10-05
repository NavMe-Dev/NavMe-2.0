#!/usr/bin/env ruby
# frozen_string_literal: true

# Backfill navme_pois description_* + descriptions via Google Translate.
# Usage:
#   ruby scripts/backfill_description_translations.rb
# Requires SUPABASE_URL + SUPABASE_ANON_KEY (or VITE_* equivalents) in env / .env.production

require 'json'
require 'net/http'
require 'uri'
require 'cgi'

ROOT = File.expand_path('..', __dir__)
ENV_FILES = [
  File.join(ROOT, '.env'),
  File.join(ROOT, '.env.production'),
  File.join(ROOT, 'poi_translator', '.env'),
].freeze

def load_env_files!
  ENV_FILES.each do |path|
    next unless File.file?(path)
    File.foreach(path) do |line|
      line = line.strip
      next if line.empty? || line.start_with?('#')
      key, val = line.split('=', 2)
      next unless key && val
      ENV[key] ||= val.strip.gsub(/\A['"]|['"]\z/, '')
    end
  end
end

load_env_files!

SUPABASE_URL = (ENV['SUPABASE_URL'] || ENV['VITE_SUPABASE_URL']).to_s.sub(%r{/\z}, '')
SUPABASE_KEY = (ENV['SUPABASE_SERVICE_ROLE_KEY'] || ENV['SUPABASE_ANON_KEY'] || ENV['VITE_SUPABASE_ANON_KEY']).to_s
OUT_DIR = File.join(ROOT, 'scripts', 'tmp')
BATCH_PATH = File.join(OUT_DIR, 'description_batches.jsonl')

LANGS = [
  %w[en en],
  %w[es es],
  %w[fr fr],
  %w[ar ar],
  %w[zh zh-CN],
  %w[ja ja],
  %w[hi hi],
  %w[kn kn],
  %w[pt pt],
  %w[ta ta],
  %w[te te],
  %w[ml ml],
  %w[bn bn],
].freeze

abort 'Missing Supabase URL/key' if SUPABASE_URL.empty? || SUPABASE_KEY.empty?

Dir.mkdir(OUT_DIR) unless Dir.exist?(OUT_DIR)

def http_json(uri, method: :get, body: nil, headers: {})
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == 'https'
  http.open_timeout = 30
  http.read_timeout = 120
  # Avoid opaque gzip bodies on older system Ruby.
  http_headers = { 'Accept-Encoding' => 'identity', 'Accept' => 'application/json' }.merge(headers)
  req =
    case method
    when :get then Net::HTTP::Get.new(uri)
    when :patch then Net::HTTP::Patch.new(uri)
    else raise "unsupported #{method}"
    end
  http_headers.each { |k, v| req[k] = v }
  req.body = body if body
  res = http.request(req)
  unless res.is_a?(Net::HTTPSuccess)
    raise "HTTP #{res.code}: #{res.body.to_s[0, 400]}"
  end
  body = res.body.to_s
  body.strip.empty? ? nil : JSON.parse(body)
end

def translate(text, target)
  return text if target == 'en' || text.to_s.strip.empty?
  uri = URI('https://translate.googleapis.com/translate_a/single')
  uri.query = URI.encode_www_form(
    [['client', 'gtx'], ['sl', 'en'], ['tl', target], ['dt', 't'], ['q', text]]
  )
  retries = 0
  begin
    data = http_json(uri)
    raise 'empty translation response' if data.nil?
    (data[0] || []).map { |part| part.is_a?(Array) ? part[0].to_s : '' }.join.strip
  rescue StandardError => e
    retries += 1
    raise if retries > 3
    warn "  retry #{retries} for #{target}: #{e.message}"
    sleep(retries * 1.5)
    retry
  end
end

def fetch_pois
  rows = []
  offset = 0
  loop do
    uri = URI("#{SUPABASE_URL}/rest/v1/navme_pois")
    uri.query = URI.encode_www_form(
      select: 'id,poi_name,description,description_es,descriptions',
      description: 'not.is.null',
      order: 'poi_name.asc',
      limit: 100,
      offset: offset,
    )
    batch = http_json(
      uri,
      headers: {
        'apikey' => SUPABASE_KEY,
        'Authorization' => "Bearer #{SUPABASE_KEY}",
        'Prefer' => 'count=exact',
      },
    )
    break if batch.nil? || batch.empty?
    rows.concat(batch)
    break if batch.length < 100
    offset += 100
  end
  rows.select { |r| r['description'].to_s.strip != '' }
end

def needs_translate?(row)
  desc = row['description'].to_s.strip
  es = row['description_es'].to_s.strip
  es.empty? || es == desc
end

def patch_poi(id, fields)
  uri = URI("#{SUPABASE_URL}/rest/v1/navme_pois?id=eq.#{CGI.escape(id)}")
  http_json(
    uri,
    method: :patch,
    body: JSON.generate(fields),
    headers: {
      'apikey' => SUPABASE_KEY,
      'Authorization' => "Bearer #{SUPABASE_KEY}",
      'Content-Type' => 'application/json',
      'Prefer' => 'return=minimal',
    },
  )
end

pois = fetch_pois
todo = pois.select { |r| needs_translate?(r) }
puts "Found #{pois.length} POIs with descriptions; #{todo.length} need translation."

File.open(BATCH_PATH, 'w') do |log|
  updated = 0
  failed = 0

  todo.each_with_index do |row, idx|
    id = row['id']
    name = row['poi_name']
    desc = row['description'].to_s.strip
    print "[#{idx + 1}/#{todo.length}] #{name} (#{desc.length} chars)... "
    $stdout.flush

    begin
      translations = {}
      LANGS.each do |code, api|
        translations[code] = code == 'en' ? desc : translate(desc, api)
        sleep 0.05
      end

      fields = { 'descriptions' => translations }
      LANGS.each { |code, _| fields["description_#{code}"] = translations[code] }

      patch_poi(id, fields)
      log.puts(JSON.generate(id: id, poi_name: name, ok: true))
      updated += 1
      puts 'ok'
    rescue StandardError => e
      failed += 1
      log.puts(JSON.generate(id: id, poi_name: name, ok: false, error: e.message))
      warn "FAILED: #{e.message}"
    end
  end

  puts "Done. updated=#{updated} failed=#{failed}"
end
