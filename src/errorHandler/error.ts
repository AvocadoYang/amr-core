import { ValidationError as YupValidationError } from 'yup';

export class ApplicationError extends Error {
  public statusCode: string;

  constructor(statusCode: string = "9999") {
    super();
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends ApplicationError {
  public errors: string;
  public type: string = 'yup';
  public msg: unknown;

  constructor(err: YupValidationError, msg: unknown) {
    super();
    this.msg = msg;
    this.errors = err.errors.join(', ');
  }
}

export class CustomerError extends ApplicationError {
    public error: string;
    public type: string = 'custom';
    public message: string;

    constructor(errorCode: string, msg: string){
        super(errorCode);
        this.message = msg;

    }
}
