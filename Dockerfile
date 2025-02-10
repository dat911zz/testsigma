FROM centos:7

WORKDIR /opt/app

# Set up CentOS repo to access required packages
RUN sed -i 's|mirrorlist=|#mirrorlist=|g' /etc/yum.repos.d/CentOS-*.repo && \
    sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*.repo

# Install dependencies
RUN yum -y update && \
    yum install -y nginx-1.20.1 openssl-devel openssl wget zip unzip dnf which && \
    dnf install --nodocs java-11-openjdk-devel -y && \
    dnf autoremove -y && \
    yum clean all && \
    dnf clean all && \
    rm -rf /var/cache/dnf

# Set JAVA_HOME and PATH for Java 11
ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk
ENV PATH=$JAVA_HOME/bin:$PATH

# Install Maven
RUN curl -sL https://archive.apache.org/dist/maven/maven-3/3.9.5/binaries/apache-maven-3.9.5-bin.tar.gz | tar xz -C /opt && \
    ln -s /opt/apache-maven-3.9.5/bin/mvn /usr/bin/mvn

# Create directories
RUN mkdir -p /etc/nginx/logs /opt/app/lib /opt/app/ts_data

# Copy configuration files and application files
COPY deploy/docker/nginx.conf /etc/nginx/nginx.conf
COPY deploy/docker/cacerts /usr/lib/jvm/jre/lib/security/
#COPY ui/dist/testsigma-angular /opt/app/angular/
COPY server/target/testsigma-server.jar /opt/app/testsigma-server.jar
COPY server/target/lib/ /opt/app/lib/
COPY server/src/main/scripts/posix/start.sh /opt/app/start.sh
COPY run-and-debug/docker/server/build_server.sh /opt/app/build_server.sh
COPY run-and-debug/docker/server/entrypoint.sh /opt/app/entrypoint.sh

# Set permissions
RUN chmod +x /opt/app/build_server.sh
RUN chmod +x /opt/app/start.sh

# Environment variables
ENV IS_DOCKER_ENV=true \
    MYSQL_HOST_NAME=${MYSQL_HOST_NAME:-mysql} \
    TS_DATA_DIR=/opt/app/ts_data \
    TESTSIGMA_WEB_PORT=${TESTSIGMA_WEB_PORT:-90} \
    TESTSIGMA_SERVER_PORT=${TESTSIGMA_SERVER_PORT:-9090}

# Expose ports
EXPOSE $TESTSIGMA_WEB_PORT $TESTSIGMA_SERVER_PORT

ENTRYPOINT ["/opt/app/entrypoint.sh"]