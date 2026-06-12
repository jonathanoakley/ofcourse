FROM denoland/deno:alpine-2.3.3
WORKDIR /app
COPY index.html .
COPY server.ts .
EXPOSE 80
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "server.ts"]
