FROM alpine:3.20

RUN apk add --no-cache openssh-server bash \
  && adduser -D -s /bin/bash testuser \
  && echo "testuser:testpass" | chpasswd \
  && mkdir -p /home/testuser/upload \
  && chown -R testuser:testuser /home/testuser/upload

COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /usr/local/bin/start-openssh

RUN chmod +x /usr/local/bin/start-openssh

EXPOSE 2222

CMD ["/usr/local/bin/start-openssh"]
