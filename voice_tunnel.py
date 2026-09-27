"""Start a public tunnel for voice mode and point backend/.env at it.

Vapi calls POST /voice/tool from its own servers, so the backend needs a public
URL. This starts a Cloudflare quick tunnel (no account needed), writes the URL
into VAPI_SERVER_URL, and keeps running until you press Ctrl+C.

    python voice_tunnel.py            # tunnels http://127.0.0.1:8000

Restart the backend after this prints the URL — the voice config is read at
start-up. The URL changes every run, so re-run this and restart the backend
whenever the tunnel goes down.

Already have ngrok or cloudflared set up? Just put your URL in
backend/.env as VAPI_SERVER_URL and skip this script.
"""
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(ROOT, "backend", ".env")
TOOLS_DIR = os.path.join(ROOT, ".tools")
PORT = int(os.getenv("PORT", "8000"))

RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
ASSETS = {
    ("Windows", "AMD64"): "cloudflared-windows-amd64.exe",
    ("Windows", "ARM64"): "cloudflared-windows-arm64.exe",
    ("Linux", "x86_64"): "cloudflared-linux-amd64",
    ("Linux", "aarch64"): "cloudflared-linux-arm64",
    ("Darwin", "x86_64"): "cloudflared-darwin-amd64.tgz",
    ("Darwin", "arm64"): "cloudflared-darwin-arm64.tgz",
}

URL_RE = re.compile(rb"https://[a-z0-9-]+\.trycloudflare\.com")


def find_cloudflared() -> str:
    found = shutil.which("cloudflared")
    if found:
        return found

    asset = ASSETS.get((platform.system(), platform.machine()))
    if not asset:
        sys.exit("No cloudflared build for this platform. Install it manually, "
                 "or set VAPI_SERVER_URL in backend/.env yourself.")
    if asset.endswith(".tgz"):
        sys.exit("On macOS install cloudflared first:  brew install cloudflared")

    os.makedirs(TOOLS_DIR, exist_ok=True)
    local = os.path.join(TOOLS_DIR, asset)
    if not os.path.exists(local):
        print(f"Downloading cloudflared into {TOOLS_DIR} (one time, ~55 MB)...")
        urllib.request.urlretrieve(RELEASES + asset, local)
        os.chmod(local, os.stat(local).st_mode | stat.S_IEXEC)
    return local


def write_server_url(url: str) -> None:
    lines, replaced = [], False
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, encoding="utf-8") as f:
            for line in f.read().splitlines():
                if line.startswith("VAPI_SERVER_URL="):
                    lines.append(f"VAPI_SERVER_URL={url}")
                    replaced = True
                else:
                    lines.append(line)
    if not replaced:
        lines += ["", "# Voice mode (Vapi)", f"VAPI_SERVER_URL={url}"]
    with open(ENV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")


def main() -> None:
    exe = find_cloudflared()
    print(f"Starting tunnel to http://127.0.0.1:{PORT} ...", flush=True)
    proc = subprocess.Popen(
        [exe, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--no-autoupdate"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )

    url, deadline = None, time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        match = URL_RE.search(line)
        if match:
            url = match.group(0).decode()
            break

    if not url:
        proc.terminate()
        sys.exit("Tunnel did not start. Check your network and try again.")

    write_server_url(url)
    print(f"\n  VAPI_SERVER_URL={url}   (written to backend/.env)")
    print("  Restart the backend so it picks this up, then use voice mode.")
    print("  Leave this running. Ctrl+C closes the tunnel.\n")

    try:
        for line in proc.stdout:
            if b"ERR" in line or b"error" in line:
                sys.stdout.write(line.decode(errors="replace"))
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
