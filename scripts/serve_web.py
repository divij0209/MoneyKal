"""Serve twin-app/ locally, telling the browser to revalidate every file.

WHY NOT `python -m http.server`
-------------------------------
The standard-library server sends `Last-Modified` and no `Cache-Control`. With
nothing explicit to go on, a browser applies *heuristic* freshness: a page last
modified days ago is treated as fresh for hours and served straight from the
HTTP cache on an ordinary navigation, without contacting the server at all.

That hides changes to the HTML itself, and cache-busting `?v=` query strings on
scripts cannot help, because the stale HTML is what names the old scripts. It
surfaced with the MoneyKal PIN: `dashboard.html` gained a gate in <head>, but a
browser that had visited before kept loading its cached copy without one, so
reopening the app never asked for the PIN.

`Cache-Control: no-cache` does not disable caching. It requires revalidation
before reuse, and this server answers If-Modified-Since with 304, so an
unchanged file still costs one small round trip and no body.

Production is unaffected: Vercel serves static files with
`max-age=0, must-revalidate` by default, which already behaves this way.

Usage:
    python scripts/serve_web.py                       # twin-app on 127.0.0.1:3000
    python scripts/serve_web.py --port 3001 --directory twin-app
"""
import argparse
import functools
import http.server
import os
import sys


class RevalidatingHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", default=os.path.join(root, "twin-app"))
    args = parser.parse_args()

    handler = functools.partial(RevalidatingHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as httpd:
        print(f"Serving {args.directory} on http://{args.bind}:{args.port} (Cache-Control: no-cache)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
