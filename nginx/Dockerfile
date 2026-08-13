FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/portifact.conf.template
COPY 15-render-env.sh /docker-entrypoint.d/15-render-env.sh
RUN chmod +x /docker-entrypoint.d/15-render-env.sh

# Nginx master runs as root to bind ports; workers drop to nginx user by default.
