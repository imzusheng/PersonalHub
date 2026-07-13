export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Task {
  taskId: string;
  capability: string;
  pluginId: string;
  input: unknown;
  status: TaskStatus;
  output: unknown | null;
  error: { message: string; details?: unknown } | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskUpdate {
  status?: TaskStatus;
  output?: unknown;
  error?: { message: string; details?: unknown } | null;
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
}

export interface SimpleJsonSchema {
  type: 'object';
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateInput(schema: SimpleJsonSchema | undefined, input: unknown): ValidationResult {
  if (!schema) return { valid: true, errors: [] };

  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    errors.push('Input must be an object');
    return { valid: false, errors };
  }

  const record = input as Record<string, unknown>;

  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in record) || record[field] === undefined || record[field] === null) {
        errors.push(`Missing required field: ${field}`);
      } else if (typeof record[field] === 'string' && !record[field].trim()) {
        errors.push(`Required field "${field}" cannot be empty`);
      }
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (key in record && record[key] !== undefined && record[key] !== null) {
        const val = record[key];
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== prop.type) {
          errors.push(`Field "${key}" must be of type ${prop.type}, got ${actualType}`);
        } else if (prop.type === 'string' && typeof val === 'string' && prop.minLength !== undefined && val.length < prop.minLength) {
          errors.push(`Field "${key}" must contain at least ${prop.minLength} characters`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
