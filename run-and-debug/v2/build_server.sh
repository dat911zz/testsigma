#!/bin/bash

# Set the root folder
ROOT_FOLDER=$(pwd)
CURRENT_DIR=$(pwd)

# Build the automator module
cd $ROOT_FOLDER/automator
mvn clean install || { echo "Build failed for automator"; exit 1; }

# Build the agent module
cd $ROOT_FOLDER/agent
mvn clean install || { echo "Build failed for agent"; exit 1; }

# Build the agent-launcher module
cd $ROOT_FOLDER/agent-launcher
mvn clean install || { echo "Build failed for agent-launcher"; exit 1; }

# Update application.properties for local agent download tag
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Build the server module
cd $ROOT_FOLDER/server
mvn clean install || { echo "Build failed for server"; exit 1; }

# Revert application.properties changes
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Return to the initial directory
cd $CURRENT_DIR

echo "Build completed successfully."
