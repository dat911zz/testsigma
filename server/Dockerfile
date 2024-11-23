# Stage 1: Build dependencies and application
FROM maven:3.9.5-eclipse-temurin-17 as builder

WORKDIR /app
COPY . .

# Set environment variable for the local agent tag
ARG LOCAL_AGENT_TAG=latest
ENV LOCAL_AGENT_TAG=${LOCAL_AGENT_TAG}

# Run the custom build script
RUN chmod +x ./build.sh && ./build.sh

# Stage 2: Create a lightweight image for running the app
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app
COPY --from=builder /app/server/target/*.jar app.jar

# Expose the default port for Spring Boot
EXPOSE 8080

ENTRYPOINT ["java", "-jar", "app.jar"]