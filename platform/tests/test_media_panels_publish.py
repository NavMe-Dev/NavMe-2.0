"""Publish freezes media_panels including text bodies and CTA buttons."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wayfinding_api.services.publish import write_media_panels


def test_write_media_panels_text_and_buttons(tmp_path: Path):
    ws = tmp_path / "ws"
    media = ws / "media"
    media.mkdir(parents=True)
    (media / "a.jpg").write_bytes(b"fake")
    dest = tmp_path / "pub"
    dest.mkdir()
    b = SimpleNamespace(
        slug="demo",
        pipeline_config={
            "media_panels": [
                {
                    "id": "img1",
                    "kind": "image",
                    "src": "media/a.jpg",
                    "model": {"x": 1, "y": 2, "z": 0},
                    "published": True,
                    "buttons": [{"label": "Go", "url": "https://example.com"}],
                },
                {
                    "id": "txt1",
                    "kind": "text",
                    "body": "Hello **x**",
                    "model": {"x": 3, "y": 4, "z": 1},
                    "published": True,
                    "buttons": [
                        {"label": "A", "url": "https://a.example"},
                        {"label": "", "url": "https://skip"},
                    ],
                },
                {"id": "empty_text", "kind": "text", "body": "", "model": {"x": 1, "y": 1}, "published": True},
                {
                    "id": "vid",
                    "kind": "video",
                    "src": "/api/v1/admin/buildings/demo/media/a.jpg",
                    "model": {"x": 0, "y": 0},
                    "published": True,
                },
            ]
        },
    )
    with patch("wayfinding_api.services.publish.ws_dir", return_value=ws):
        out = write_media_panels(b, dest)
    assert (dest / "media_panels.json").exists()
    assert (dest / "media" / "a.jpg").exists()
    assert [p["id"] for p in out] == ["img1", "txt1", "vid"]
    txt = next(p for p in out if p["id"] == "txt1")
    assert txt["kind"] == "text" and "Hello" in txt["body"]
    assert txt["buttons"] == [{"label": "A", "url": "https://a.example"}]
    img = next(p for p in out if p["id"] == "img1")
    assert img["buttons"][0]["label"] == "Go"
    vid = next(p for p in out if p["id"] == "vid")
    assert vid["src"] == "media/a.jpg"
