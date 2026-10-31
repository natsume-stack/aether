declare module 'swagger-parser-mock' {
    export interface SwaggerEntity {
        paths: {
            [path: string]: {
                [method: string]: {
                    responses: {
                        200: { example: string };
                        401: { example: string };
                        403: { example: string };
                        404: { example: string };
                    };
                };
            };
        };
    }

    const swaggerParserMock: (url: string) => Promise<SwaggerEntity>;

    export default swaggerParserMock;
}
