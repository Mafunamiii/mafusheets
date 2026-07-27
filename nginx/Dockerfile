FROM nginx:1.28-alpine

COPY --chown=root:root --chmod=0444 nginx.conf /etc/nginx/nginx.conf
COPY --chown=root:root --chmod=0444 security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 8080 8443
