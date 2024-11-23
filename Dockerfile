FROM centos:7

WORKDIR /opt/app

# Install dependencies
RUN yum -y update && \
    yum install -y nginx-1.20.1 openssl-devel openssl wget zip unzip dnf which && \
    dnf install --nodocs java-11-openjdk -y && \
    dnf autoremove -y && \
    yum clean all && \
    dnf clean all && \
    rm -rf /var/cache/dnf

# Create directories
RUN mkdir -p /etc/nginx/logs /opt/app/lib /opt/app/ts_data

# Copy configuration files and application files
COPY deploy/docker/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/cacerts /usr/lib/jvm/jre/lib/security/
COPY ui/dist/testsigma-angular /opt/app/angular/
COPY server/target/testsigma-server.jar /opt/app/testsigma-server.jar
COPY server/target/lib/ /opt/app/lib/
COPY server/src/main/scripts/posix/start.sh /opt/app/
COPY run-and-debug/v2/build_server.sh /opt/app/build_server.sh

# Set permissions
RUN chmod +x /opt/app/start.sh 
RUN chmod +x /opt/app/build_server.sh

# Environment variables
ENV IS_DOCKER_ENV=true \
    MYSQL_HOST_NAME=${MYSQL_HOST_NAME:-mysql} \
    TS_DATA_DIR=/opt/app/ts_data \
    TESTSIGMA_WEB_PORT=${TESTSIGMA_WEB_PORT:-443} \
    TESTSIGMA_SERVER_PORT=${TESTSIGMA_SERVER_PORT:-9090}

# Expose ports
EXPOSE $TESTSIGMA_WEB_PORT $TESTSIGMA_SERVER_PORT