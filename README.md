openapi: 3.1.0
info:
  title: Notion Write API
  version: 1.2.0
servers:
  - url: -------------변경----------------------

components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: x-api-key

security:
  - ApiKeyAuth: []

paths:
  /health:
    get:
      operationId: health
      responses:
        "200":
          description: OK

  /find_page:
    get:
      operationId: findPage
      parameters:
        - name: title
          in: query
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK

  /read_page:
    get:
      operationId: readPage
      parameters:
        - name: page_id
          in: query
          required: true
          schema:
            type: string
      responses:
        "200":
          description: OK

  /update_page:
    post:
      operationId: updatePage
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [page_id, content]
              properties:
                page_id:
                  type: string
                content:
                  type: string
      responses:
        "200":
          description: OK

  /create_page:
    post:
      operationId: createPage
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [parent_page_id, title, content]
              properties:
                parent_page_id:
                  type: string
                title:
                  type: string
                content:
                  type: string
      responses:
        "200":
          description: OK

  /append_by_title:
    post:
      operationId: appendByTitle
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [title, content]
              properties:
                title:
                  type: string
                content:
                  type: string
      responses:
        "200":
          description: OK

  /replace_by_title:
    post:
      operationId: replaceByTitle
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [title, content, confirm]
              properties:
                title:
                  type: string
                content:
                  type: string
                confirm:
                  type: boolean
      responses:
        "200":
          description: OK
