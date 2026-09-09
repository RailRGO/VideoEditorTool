#!/usr/bin/env python3
"""Generate a fake 3840x1080 side-by-side video for quick pipeline testing.
Usage: python make_fake.py --duration 30 --out /tmp/fake.mp4"""
import argparse, subprocess, sys
from pathlib import Path

def make_fake(duration=30, out="/tmp/fake_3840.mp4"):
    # Background: solid dark + some noise patterns to simulate content
    # Left half = camera (solid purple), right half = content (gradient blue)
    filter_complex = (
        "split=2[bg][mask];"
        "[bg]color=c=#1a0b2e:s=3840x1080:d=30[bgfull];"
        "[bgfull][mask]blend=all_mode=addition[blend];"
        # Draw left rectangle (camera)
        "drawbox=x=0:y=0:w=1920:h=1080:color=#4a1942:t=fill[cam];"
        # Draw right rectangle (content) with gradient
        "drawbox=x=1920:y=0:w=1920:h=1080:color=#1a3a4a:t=fill[cont];"
        # Combine
        "[blend][cam]overlay=0:0:enable='between(t,0,30)'[b1];"
        "[b1][cont]overlay=1920:0:enable='between(t,0,30)'[outv]"
    )
    # Actually simpler: just use color sources and overlay
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=#222233:s=3840x1080:d={duration}",
        "-f", "lavfi", "-i", f"color=c=#4a1942:s=1920x1080:d={duration}",
        "-f", "lavfi", "-i", f"color=c=#1a3a4a:s=1920x1080:d={duration}",
        "-filter_complex",
        "[1:v][2:v]hstack=inputs=2[side];[0:v][side]blend=all_mode=normal[final]",
        "-map", "[final]", "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-an", out
    ]
    subprocess.run(cmd, check=False)
    print("Created fake video:", out)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=int, default=30)
    parser.add_argument("--out", default="/tmp/fake_3840.mp4")
    args = parser.parse_args()
    make_fake(args.duration, args.out)
