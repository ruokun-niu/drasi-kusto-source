.PHONY: default docker-build kind-load

IMAGE_PREFIX ?= drasi-project
DOCKER_TAG_VERSION ?= latest
TAG_SUFFIX ?=
DOCKERX_OPTS ?= --load --cache-to type=inline
BUILD_CONFIG ?= default

default: docker-build

docker-build:
	docker buildx build . -f Dockerfile -t $(IMAGE_PREFIX)/source-kusto-reactivator:$(DOCKER_TAG_VERSION) $(DOCKERX_OPTS)

kind-load:
	kind load docker-image $(IMAGE_PREFIX)/source-kusto-reactivator:$(DOCKER_TAG_VERSION) --name $(if $(CLUSTER_NAME),$(CLUSTER_NAME),kind)