"""wfpipe – turn a Matterport MatterPak (+ model id + address) into indoor-wayfinding data.

Steps are small, idempotent functions registered in ``wfpipe.runner.STEPS``. Each writes its
artefacts into the building workspace (``<root>/work`` for intermediates, ``<root>/out`` for the
viewer bundle) and records a fingerprint in ``work/state.json`` so re-runs skip up-to-date steps.
"""
__version__ = "0.1.0"
