-- Self-service profile read/update for navme_accounts (add-only RPCs; no table reshape).

CREATE OR REPLACE FUNCTION public.account_get_own_profile(
  p_email text,
  p_password text
)
RETURNS TABLE (
  account_id uuid,
  email text,
  display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
  acc public.navme_accounts%ROWTYPE;
BEGIN
  aid := public.verify_navme_account(p_email, p_password);
  IF aid IS NULL THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  SELECT * INTO acc FROM public.navme_accounts WHERE id = aid;
  IF NOT FOUND OR NOT acc.is_active THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  account_id := acc.id;
  email := acc.email;
  display_name := acc.display_name;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.account_update_own_profile(
  p_email text,
  p_password text,
  p_display_name text DEFAULT NULL,
  p_new_email text DEFAULT NULL,
  p_new_password text DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  email text,
  display_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  aid uuid;
  acc public.navme_accounts%ROWTYPE;
  next_email text;
  next_password text;
  next_display text;
  conflict_id uuid;
BEGIN
  aid := public.verify_navme_account(p_email, p_password);
  IF aid IS NULL THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  SELECT * INTO acc FROM public.navme_accounts WHERE id = aid;
  IF NOT FOUND OR NOT acc.is_active THEN
    RAISE EXCEPTION 'Invalid credentials';
  END IF;

  next_email := acc.email;
  IF p_new_email IS NOT NULL AND length(trim(p_new_email)) > 0 THEN
    next_email := trim(p_new_email);
  END IF;

  next_password := acc.password;
  IF p_new_password IS NOT NULL AND length(p_new_password) > 0 THEN
    next_password := p_new_password;
  END IF;

  IF p_display_name IS NULL THEN
    next_display := acc.display_name;
  ELSE
    next_display := nullif(trim(p_display_name), '');
  END IF;

  IF lower(trim(next_email)) <> lower(trim(acc.email)) THEN
    SELECT id INTO conflict_id
    FROM public.navme_accounts
    WHERE lower(trim(email)) = lower(trim(next_email))
      AND id <> aid
    LIMIT 1;
    IF conflict_id IS NOT NULL THEN
      RAISE EXCEPTION 'Email already in use';
    END IF;
  END IF;

  UPDATE public.navme_accounts
  SET
    email = next_email,
    password = next_password,
    display_name = next_display,
    updated_at = now()
  WHERE id = aid
  RETURNING
    public.navme_accounts.id,
    public.navme_accounts.email,
    public.navme_accounts.display_name
  INTO account_id, email, display_name;

  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_get_own_profile(text, text) TO anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_update_own_profile(text, text, text, text, text) TO anon, authenticated, PUBLIC;
