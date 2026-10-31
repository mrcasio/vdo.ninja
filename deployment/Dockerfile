FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

RUN cp /usr/bin/caddy /usr/local/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
COPY --chown=10001:10001 src/ /srv/

ENV XDG_CONFIG_HOME=/tmp XDG_DATA_HOME=/tmp
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
