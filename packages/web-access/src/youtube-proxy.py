"""Network-namespace bridge: loopback TCP to one host Unix CONNECT proxy.

Executed with python3 -I inside bubblewrap, never on the host directly. yt-dlp
only extracts metadata; media bytes are fetched by the validating Node parent.
"""
import os
import select
import socket
import socketserver
import subprocess
import sys
import threading


class Bridge(socketserver.BaseRequestHandler):
    def handle(self):
        with self.server.lock:
            self.server.accepted += 1
            if self.server.accepted > 50:
                return
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.settimeout(15)
            self.request.settimeout(15)
            upstream.connect(self.server.unix_path)
            while True:
                readable, _, _ = select.select([self.request, upstream], [], [], 15)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    target = upstream if source is self.request else self.request
                    target.sendall(data)
        except (OSError, ValueError):
            return
        finally:
            upstream.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 8


def main():
    unix_path, executable, url = sys.argv[1:]
    node = next((path for path in ['/usr/bin/node', '/usr/local/bin/node'] if os.access(path, os.X_OK)), None)
    # Only a system Node inside the namespace may solve signatures. yt-dlp's EJS
    # component must be installed locally; remote component downloads stay disabled.
    runtime = ['--js-runtimes', 'node:' + node] if node else []
    # All arguments are independently selected/validated by the parent.
    with Server(('127.0.0.1', 0), Bridge) as server:
        server.unix_path = unix_path
        server.accepted = 0
        server.lock = threading.Lock()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run([
                executable,
                '--proxy', 'http://127.0.0.1:%d' % server.server_address[1],
                '--ignore-config', '--no-playlist', '--no-cache-dir',
                '--no-plugin-dirs', '--no-remote-components', '--no-js-runtimes', *runtime,
                '--skip-download', '--dump-single-json',
                '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0',
                '--format', 'best[ext=mp4][protocol=https]/best[protocol=https]',
                '--', url,
            ], shell=False, stdin=subprocess.DEVNULL, cwd='/tmp', env={
                'PATH': '/usr/bin:/bin', 'HOME': '/tmp/home',
                'XDG_CONFIG_HOME': '/tmp/home', 'LANG': 'C.UTF-8',
                'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt',
            })
            return result.returncode
        finally:
            server.shutdown()
            thread.join()


if __name__ == '__main__':
    sys.exit(main())
