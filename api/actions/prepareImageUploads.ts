// Gadget action: prepareImageUploads
// Returns staged upload targets for image files so the client can upload

export const params = {
  files: {
    type: "array",
    items: {
      type: "object",
      properties: {
        filename: { type: "string" },
        mimeType: { type: "string" },
        size: { type: "number" },
        httpMethod: { type: "string" },
      },
    },
  },
};

type FileDescriptor = {
  filename: string;
  mimeType: string;
  size?: number;
  httpMethod?: "POST" | "PUT"; // Images can support both; default to POST
};

type Params = {
  files: FileDescriptor[];
};

const STAGED_UPLOADS_CREATE = /* GraphQL */ `
  mutation StagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

export const run = async ({ params, connections }: any) => {
  const p = params as unknown as Params;
  console.log("[prepareImageUploads] run start", { files: Array.isArray(p?.files) ? p.files.length : 0 });
  if (!p?.files || !Array.isArray(p.files) || p.files.length === 0) {
    throw new Error("files must be a non-empty array");
  }

  const shopify = connections.shopify?.current;
  if (!shopify) throw new Error("No active Shopify connection for this session");

  const input = p.files.map((f) => ({
    filename: f.filename,
    mimeType: f.mimeType,
    httpMethod: (f.httpMethod ?? "POST") as any,
    resource: "IMAGE",
    fileSize: typeof f.size === "number" ? String(f.size) : undefined,
  }));
  console.log("[prepareImageUploads] stagedUploadsCreate input", input.map((i) => ({ filename: i.filename, mimeType: i.mimeType })));

  const json = await shopify.graphql(STAGED_UPLOADS_CREATE, { input });
  const errors = json?.stagedUploadsCreate?.userErrors ?? json?.errors ?? json?.data?.stagedUploadsCreate?.userErrors;
  if (errors && errors.length) {
    console.error("[prepareImageUploads] userErrors", errors);
    throw new Error(errors.map((e: any) => e.message).join("; "));
  }

  const targets = json?.stagedUploadsCreate?.stagedTargets ?? json?.data?.stagedUploadsCreate?.stagedTargets ?? [];
  console.log("[prepareImageUploads] targets returned", targets.length);
  return { targets };
};
