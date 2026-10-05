# Copy a finished E57 from the Windows Matterpak folder onto the box

The user’s Matterport downloads land in:

`C:\Users\patis\OneDrive\phygital\Matterport\Matterpak\`

Matterport delivers E57 as `mp_e57_<Site>_<modelId>.zip` containing a single `cloud_0.e57`
(often multi-GB). Chrome may show `Unconfirmed *.crdownload` until finished.
**Do not copy while still `.crdownload`.** You can CopyToBox either the zip or the extracted `.e57`.

Current Tacoma example (2026-09-29):
- Zip: `…\Matterpak\mp_e57_4926-Tacoma-Dr_pAFsSSgF5kj.zip` (~3.58 GB)
- Extracted: `…\Matterpak\4926-Tacoma-Dr\cloud_0.e57` (~4.82 GB)
- Model ID: `pAFsSSgF5kj`

## When the user says the download is done

From a Grok / agent session with the Fortune desktop connected:

1. Confirm the file is `*.e57` (not `.crdownload`) and note its size.
2. Copy into the box, e.g.:

```text
CopyToBox
  computer_path: C:\Users\patis\OneDrive\phygital\Matterport\Matterpak\<name>.e57
  box_path:      /workspace/wayfinding/matterpak/<slug>/source.e57
  machineId:     <Fortune machineId>
```

Or create the folder first:

```bash
mkdir -p /workspace/wayfinding/matterpak/<slug>
```

3. In **Add building → MatterPak or E57**, paste the server path:

`/workspace/wayfinding/matterpak/<slug>/source.e57`

(or the folder `/workspace/wayfinding/matterpak/<slug>/` if it contains exactly one `.e57`).

4. Prefer server path over browser upload for files ≳ 2 GB (`MAX_UPLOAD_MB` default is 8192).

## CLI after path is set

```bash
cd /workspace/wayfinding/platform
set -a; . ./.env; set +a
# matterpak_path already on the building row, or:
.venv/bin/wayfinding onboard <slug> --inline
```
