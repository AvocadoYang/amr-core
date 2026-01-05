declare namespace NodeJS {
  export type ProcessEnv = {
    [x: string]: string;
    NODE_CONFIG_ENV: string;
  };
}

