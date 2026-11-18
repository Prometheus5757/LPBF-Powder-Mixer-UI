"""Static server for the LPBF Mixer UI (used by start-ui.bat).

Serves the project folder on http://127.0.0.1:8765 (this computer only) and tells the
browser to re-check every file, so an updated UI is never hidden behind a cached copy.
Run: python tools/serve.py [port]
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript",
                      ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".md": "text/markdown; charset=utf-8"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")   # revalidate every time; unchanged files still answer 304
        super().end_headers()

    def log_message(self, fmt, *args):                   # keep the console quiet apart from errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8765"))
    print(f"LPBF Mixer UI on http://localhost:{port}/ui/  (close this window to stop it)", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
