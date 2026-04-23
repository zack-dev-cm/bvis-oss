"""
Generate photo-real beauty feed assets with Google Gemini (tiny \"nano-banano\" helper).

This mirrors the workflow in toddler_games/scripts/generate_ai_assets.py.

Usage:
  export GOOGLE_API_KEY=your_key
  python scripts/generate_nano_banano_assets.py \\
    --prompt "photo-real nail bar, neutral background, natural skin tones, 50mm lens" \\
    --prefix apps/api/mock-media/mock-batch

Notes:
- Requires `pip install google-genai`.
- Streams image blobs; saves them to <prefix>_<index>.<ext>.
- Set `--size` to 512x512 / 1K / 2K etc. (Gemini image-preview sizes).
"""

import argparse
import mimetypes
import os
from pathlib import Path

import google.genai as genai
from google.genai import types


def save_file(path: Path, data: bytes) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_bytes(data)
  print(f"Saved {path}")


def generate(prompt: str, prefix: str, size: str) -> None:
  api_key = os.environ.get("GOOGLE_API_KEY")
  if not api_key:
    raise SystemExit("GOOGLE_API_KEY is required to call Gemini.")

  client = genai.Client(api_key=api_key)
  model = "gemini-3-pro-image-preview"
  contents = [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])]
  config = types.GenerateContentConfig(
      response_modalities=["IMAGE", "TEXT"],
      image_config=types.ImageConfig(image_size=size),
  )

  index = 0
  for chunk in client.models.generate_content_stream(model=model, contents=contents, config=config):
    if not chunk.candidates:
      continue
    part = chunk.candidates[0].content.parts[0]
    if getattr(part, "inline_data", None) and part.inline_data.data:
      mime = part.inline_data.mime_type or "image/png"
      ext = mimetypes.guess_extension(mime) or ".png"
      target = Path(f"{prefix}_{index}{ext}")
      save_file(target, part.inline_data.data)
      index += 1
    elif chunk.text:
      print(chunk.text)


def main() -> None:
  parser = argparse.ArgumentParser(description="Nano-banano asset generator (Gemini).")
  parser.add_argument("--prompt", required=True, help="Prompt describing the beauty photo you want.")
  parser.add_argument("--prefix", required=True, help="Output file prefix, e.g. apps/api/mock-media/mock-manicure")
  parser.add_argument(
      "--size",
      default="1K",
      choices=["256x256", "512x512", "1024x1024", "1K", "2K"],
      help="Output resolution hint."
  )
  args = parser.parse_args()
  generate(args.prompt, args.prefix, args.size)


if __name__ == "__main__":
  main()
