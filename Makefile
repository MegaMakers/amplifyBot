

.PHONY: setup
setup:
	docker run --env-file=.dev.env -v ${PWD}:/amplify -w /amplify node:10.16.3-alpine npm install

.PHONY: run
run:
	docker run --env-file=.dev.env -v ${PWD}:/amplify -w /amplify node:10.16.3-alpine npm start