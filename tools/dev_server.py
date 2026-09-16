import http.server
import socketserver
import os
import sys

PORT = 8080

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Force browser to never cache modules, js, html, or css during development
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

class ThreadingDevServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == '__main__':
    # Serve from project root (parent directory of tools)
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(project_root)
    
    with ThreadingDevServer(("", PORT), NoCacheHTTPRequestHandler) as httpd:
        print(f"[DevServer] Serving {project_root} on http://localhost:{PORT} (Cache-Control: no-cache, Multi-threaded)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[DevServer] Stopping server...", flush=True)
