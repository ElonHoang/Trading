FROM maven:3.9-eclipse-temurin-17 AS build

WORKDIR /workspace
COPY . .

RUN mvn -f server-java/pom.xml clean package -DskipTests


FROM eclipse-temurin:17-jre

WORKDIR /app

COPY --from=build /workspace/server-java/target/auth-server-1.0.0.jar app.jar

EXPOSE 10000

CMD ["sh", "-c", "java -Dserver.port=${PORT:-10000} -jar app.jar"]
