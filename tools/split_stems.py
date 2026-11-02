"""
Split songs into instrument stems for KySync with Demucs, on your own computer.

Why: the in-browser splitter gives 4 tracks (drums, bass, vocals, other). Running Demucs
locally lets you use the 6-stem model, which adds separate guitar and piano tracks, and
it's faster if you have an NVIDIA GPU.

Setup (once, e.g. in an Anaconda prompt):
    conda install -c conda-forge ffmpeg      # Demucs reads songs through ffmpeg
    pip install demucs                        # pulls in PyTorch

Use:
    python tools/split_stems.py "Artist - Title.mp3" "Another Song.flac"

Each song ends up in stems/<song name>/ as drums, bass, vocals, guitar, piano, other
(MP3), plus a copy of the original as mix.<ext>. In KySync, click "+ Add stems" and pick
that song's folder, or pick the whole stems/ folder to add every song in it.
"""

import argparse
import shutil
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="Split songs into stems for KySync (Demucs).")
    ap.add_argument("songs", nargs="+", type=Path, help="audio files to split")
    ap.add_argument("-o", "--out", type=Path, default=Path("stems"), help="output folder (default: stems)")
    ap.add_argument("--four", action="store_true", help="4-stem model: faster, no separate guitar/piano")
    ap.add_argument("--wav", action="store_true", help="write WAV instead of MP3 (lossless, ~10x bigger)")
    args = ap.parse_args()

    try:
        import demucs.separate
    except ImportError:
        sys.exit("Demucs isn't installed. Run:  pip install demucs")

    model = "htdemucs" if args.four else "htdemucs_6s"
    work = args.out / "_demucs"
    done = []
    for song in args.songs:
        if not song.is_file():
            print(f"Skipping {song}: not a file")
            continue
        print(f"Splitting {song.name} with {model}...")
        opts = ["-n", model, "-o", str(work)]
        if not args.wav:
            opts += ["--mp3", "--mp3-bitrate", "256"]
        demucs.separate.main(opts + [str(song)])

        # Demucs writes <work>/<model>/<song name>/<stem>.<ext>; move it to <out>/<song name>/
        src = work / model / song.stem
        dest = args.out / song.stem
        dest.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            shutil.move(str(f), str(dest / f.name))
        shutil.copy2(song, dest / f"mix{song.suffix.lower()}")
        done.append(dest)

    shutil.rmtree(work, ignore_errors=True)
    if done:
        print("\nReady for KySync (+ Add stems):")
        for d in done:
            print(f"  {d}")


if __name__ == "__main__":
    main()
