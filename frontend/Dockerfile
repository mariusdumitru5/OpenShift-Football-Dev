# nginx non privilegiato: ascolta sulla 8080 e gira con UID arbitrario (ok per OpenShift).
# La configurazione nginx NON è nell'immagine: arriva dalla ConfigMap-frontend
# generata da Kustomize e montata in /etc/nginx/conf.d.
FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine

COPY public/ /usr/share/nginx/html/

EXPOSE 8080
