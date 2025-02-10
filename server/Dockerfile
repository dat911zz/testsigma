# Stage 0
FROM alpine AS collector
WORKDIR /collector
COPY ../run-and-debug/docker/server/build_server.sh ./build_server.sh

# Stage 1: Build dependencies and application
FROM maven:3.9.5-eclipse-temurin-17 as builder

WORKDIR /app
COPY . .

# Set environment variable for the local agent tag
ARG LOCAL_AGENT_TAG=latest
ENV LOCAL_AGENT_TAG=${LOCAL_AGENT_TAG}

# Run the custom build script
COPY .testsigma_os/windows/jre /opt/app/jre
COPY server/target/testsigma-server.jar /opt/app/testsigma-server.jar
COPY server/target/lib/ /opt/app/lib/
COPY server/src/main/scripts/posix/start.sh /opt/app/
COPY --from=collector /collector/build_server.sh /opt/app/build_server.sh

RUN chmod +x /opt/app/build/build_server.sh
# Stage 2: Create a lightweight image for running the app
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app
COPY --from=builder /app/server/target/*.jar app.jar
RUN chmod +x /opt/app/start.sh

# Expose the default port for Spring Boot
EXPOSE 9090

ENTRYPOINT ["java", "-jar", "app.jar"]