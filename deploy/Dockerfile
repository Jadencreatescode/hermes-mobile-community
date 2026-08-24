FROM python:3.13.7-slim-bookworm

RUN pip install --no-cache-dir aiohttp==3.14.3

WORKDIR /app
COPY dist ./dist
COPY server ./server

USER 65532:65532
EXPOSE 4176
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4176/manifest.webmanifest', timeout=3).read()"]

ENTRYPOINT ["python", "server/mobile_relay.py"]
CMD ["--static-root", "dist", "--upstream", "http://127.0.0.1:9119", "--host", "127.0.0.1", "--port", "4176"]
