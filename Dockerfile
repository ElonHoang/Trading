FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /workspace

COPY server-java/pom.xml server-java/pom.xml
RUN mvn -f server-java/pom.xml dependency:go-offline

COPY . .
RUN mvn -f server-java/pom.xml clean package


FROM eclipse-temurin:17-jre

WORKDIR /app

COPY --from=build /workspace/server-java/target/dong-tien-ai.jar app.jar
COPY --from=build /workspace/config ./config
COPY --from=build /workspace/models ./models
COPY --from=build /workspace/data ./data

EXPOSE 10000

CMD ["sh", "-c", "java -Dserver.port=${PORT:-10000} -jar app.jar"]
