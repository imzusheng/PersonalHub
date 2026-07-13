import { z } from 'zod';

const ALLOWED_RUNTIMES = ['mock', 'docker', 'wsl', 'native', 'python-venv', 'wsl-docker'] as const;
const ALLOWED_HEALTHCHECK_TYPES = ['mock', 'http', 'process'] as const;

const JsonSchemaObjectSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.object({
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  }).passthrough()).optional(),
}).passthrough();

const CapabilitySchema = z.object({
  name: z.string().min(1),
  inputSchema: JsonSchemaObjectSchema,
  outputSchema: JsonSchemaObjectSchema.optional(),
  description: z.string().optional(),
});

const HealthcheckSchema = z.object({
  type: z.enum(ALLOWED_HEALTHCHECK_TYPES),
}).passthrough();

const DeploymentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('dockerfile'), dockerfile: z.string().default('Dockerfile'), context: z.string().default('.') }),
  z.object({ type: z.literal('script'), entrypoint: z.string().min(1), interpreter: z.enum(['sh', 'bash', 'python', 'powershell']).optional() }),
]);

const PluginManifestBaseSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  runtime: z.enum(ALLOWED_RUNTIMES),
  capabilities: z.array(CapabilitySchema).min(1),
  healthcheck: HealthcheckSchema.optional(),
  description: z.string().optional(),
  runtimeConfig: z.record(z.unknown()).optional(),
  deployment: DeploymentSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestBaseSchema>;

export type PluginCapability = z.infer<typeof CapabilitySchema>;

export function isRuntimeSupportedOnPlatform(runtime: PluginManifest['runtime'], platform: NodeJS.Platform): boolean {
  if (runtime === 'wsl-docker' || runtime === 'wsl') return platform === 'win32';
  return true;
}

export const PluginManifestSchema = PluginManifestBaseSchema.superRefine((manifest, ctx) => {
  const seenNames = new Set<string>();
  for (const cap of manifest.capabilities) {
    if (seenNames.has(cap.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate capability name: ${cap.name}`,
        path: ['capabilities'],
      });
      return;
    }
    seenNames.add(cap.name);
  }
  const deploymentPaths = manifest.deployment?.type === 'dockerfile'
    ? [manifest.deployment.context, manifest.deployment.dockerfile]
    : manifest.deployment?.type === 'script' ? [manifest.deployment.entrypoint] : [];
  for (const deploymentPath of deploymentPaths) {
    const segments = deploymentPath.replace(/\\/g, '/').split('/');
    if (!deploymentPath || deploymentPath.startsWith('/') || /^[a-zA-Z]:/.test(deploymentPath) || segments.includes('..')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Deployment path must stay inside the plugin directory: ${deploymentPath}`, path: ['deployment'] });
    }
  }
});

export interface ManifestParseSuccess {
  success: true;
  data: PluginManifest;
}

export interface ManifestParseFailure {
  success: false;
  error: {
    code: 'INVALID_MANIFEST';
    message: string;
    issues: z.ZodIssue[];
  };
}

export type ManifestParseResult = ManifestParseSuccess | ManifestParseFailure;

export function parsePluginManifest(input: unknown): ManifestParseResult {
  const result = PluginManifestSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: {
      code: 'INVALID_MANIFEST' as const,
      message: result.error.issues.map((i) => i.message).join('; '),
      issues: result.error.issues,
    },
  };
}
