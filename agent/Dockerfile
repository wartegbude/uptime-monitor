# Build: docker build -t uptime-agent ./agent
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /uptime-agent .

FROM gcr.io/distroless/static-debian12
COPY --from=build /uptime-agent /uptime-agent
ENV UPTIME_DATA_DIR=/var/lib/uptime-agent
VOLUME /var/lib/uptime-agent
# ICMP needs NET_RAW: docker run --cap-add NET_RAW ...
ENTRYPOINT ["/uptime-agent"]
