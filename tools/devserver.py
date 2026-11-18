"""Local helper server for the model converter (tools/convert.html).

Serves the project folder on http://127.0.0.1:8766 and accepts
POST /__save?name=<file> to write the converted model into ui/assets/.
Only plain file names with the extensions below are accepted, so nothing
outside ui/assets can be written. Run: python tools/devserver.py
"""
import http.server
import os
import re
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "ui", "assets")
ALLOWED = re.compile(r"^[A-Za-z0-9_.-]+\.(glb|json)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        name = urllib.parse.parse_qs(url.query).get("name", [""])[0]
        if url.path != "/__save" or not ALLOWED.match(name):
            self.send_error(400, "bad save request")
            return
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)
        os.makedirs(ASSETS, exist_ok=True)
        with open(os.path.join(ASSETS, name), "wb") as f:
            f.write(data)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(f"saved {name} ({len(data)} bytes)".encode())


if __name__ == "__main__":
    Handler.extensions_map = {**Handler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript"}
    port = int(os.environ.get("PORT", "8766"))
    print("Serving", ROOT, f"on http://127.0.0.1:{port}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
