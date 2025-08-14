// Gadget action: bulkDuplicateProducts

export const params = {
  sourceProductId: { type: "string" },
  duplicates: {
    type: "array",
    items: {
      type: "object",
      properties: {
        title: { type: "string" },
        imageUrls: { type: "array", items: { type: "string" } },
        descriptionHtml: { type: "string" },
        vendor: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        productType: { type: "string" },
        price: { type: "string" },
      },
    },
  },
};

type DuplicateInput = {
  title?: string;
  imageUrls?: string[];
  descriptionHtml?: string;
  vendor?: string;
  tags?: string[] | string; // allow comma-separated string too
  productType?: string;
  price?: string; // applied to initial variant
};

type Params = {
  sourceProductId: string; // gid://shopify/Product/...
  duplicates: DuplicateInput[];
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PRODUCT_BASE_QUERY = /* GraphQL */ `
  query BaseProduct($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      vendor
      productType
      tags
      options {
        id
        name
        optionValues { id name }
      }
      variants(first: 250) {
        nodes {
          id
          price
          selectedOptions { name value }
        }
      }
      media(first: 50) {
        nodes {
          mediaContentType
          ... on MediaImage { id image { url } }
          preview { image { url } }
        }
      }
    }
  }
`;

const PRODUCT_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        options { id name }
        variants(first: 1) { nodes { id } }
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE = /* GraphQL */ `
  mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product { id }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_CREATE = /* GraphQL */ `
  mutation CreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

export const run = async ({ params, connections, logger }: any) => {
  const p = params as unknown as Params;

  console.log("ppppppppppppppp", p);

  console.log("[bulkDuplicateProducts] run start", {
    hasSource: Boolean(p?.sourceProductId),
    duplicatesCount: Array.isArray(p?.duplicates) ? p.duplicates.length : 0,
  });
  if (!p?.sourceProductId) throw new Error("sourceProductId is required");

  //  Normalize to Shopify GID if a numeric or non-GID ID is provided
  const normalizeGid = (id: string) =>
    id?.startsWith("gid://") ? id : `gid://shopify/Product/${id.replace(/^.*\/(\d+)$/, "$1")}`;
  const sourceGid = normalizeGid(p.sourceProductId);
  console.log("[bulkDuplicateProducts] normalized sourceGid", sourceGid);
  if (!/^gid:\/\/shopify\/Product\/.+/.test(sourceGid)) {
    throw new Error("sourceProductId must be a valid Shopify Product Global ID (e.g., gid://shopify/Product/12345)");
  }
  if (!Array.isArray(p.duplicates) || p.duplicates.length === 0) {
    throw new Error("duplicates must be a non-empty array");
  }

  const shopify = connections.shopify?.current;
  if (!shopify) throw new Error("No active Shopify connection for this session");

  // 1) Fetch base product
  console.log("[bulkDuplicateProducts] fetching base product");
  const baseJson = await shopify.graphql(PRODUCT_BASE_QUERY, { id: sourceGid });
  const base = baseJson?.product ?? baseJson?.data?.product; // support both shapes just in case
  if (!base) throw new Error("Base product not found");
  console.log(" base loaded", {
    id: base.id,
    title: base.title,
    options: (base.options ?? []).length,
    variants: (base.variants?.nodes ?? []).length,
  });

  const baseImageUrls: string[] = [];
  for (const node of base.media?.nodes ?? []) {
    if (node?.mediaContentType === "IMAGE") {
      const url = node?.image?.url || node?.preview?.image?.url;
      if (url) baseImageUrls.push(url);
    }
  }

  console.log("[bulkDuplicateProducts] base images", baseImageUrls.length);

  const newProductIds: string[] = [];

  // 2) Create each duplicate sequentially, with a small delay for rate limiting
  for (const [idx, dup] of p.duplicates.entries()) {
    console.log(`[bulkDuplicateProducts] duplicate ${idx + 1}/${p.duplicates.length} start`);
    const mediaUrls = Array.isArray(dup.imageUrls) && dup.imageUrls.length > 0 ? dup.imageUrls : baseImageUrls;
    console.log("[bulkDuplicateProducts] mediaUrls count", mediaUrls?.length ?? 0);

    // Build ProductCreateInput by cloning base & applying overrides
    const productInput: any = {
      title: dup.title && dup.title.trim().length > 0 ? dup.title.trim() : base.title,
      descriptionHtml: dup.descriptionHtml ?? base.descriptionHtml ?? undefined,
      vendor: dup.vendor ?? base.vendor ?? undefined,
      productType: dup.productType ?? base.productType ?? undefined,
      tags: Array.isArray(dup.tags)
        ? dup.tags
        : typeof dup.tags === "string"
          ? dup.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
          : base.tags ?? [],
      // status remains default (DRAFT/UNPUBLISHED); publishing can be added later if desired
      // Create options on the product to match the base product
      productOptions: (base.options ?? []).map((opt: any) => ({
        name: opt.name,
        values: (opt.optionValues ?? []).map((ov: any) => ({ name: ov.name })),
      })),
    };
    console.log("[bulkDuplicateProducts] productInput summary", {
      title: productInput.title,
      vendor: productInput.vendor,
      productType: productInput.productType,
      tagsCount: productInput.tags?.length ?? 0,
      optionCount: productInput.productOptions?.length ?? 0,
    });

    console.log("productInput.title", productInput.title)
    console.log("productInput.title", productInput.vendor)
    console.log("productInput.title", productInput.productType)
    console.log("productInput.title", productInput.tags?.length)
    console.log("productInput.title", productInput.productOptions?.length)

    const mediaInput = (mediaUrls ?? []).slice(0, 50).map((url: string) => ({
      originalSource: url,
      mediaContentType: "IMAGE",
    }));
    console.log("[bulkDuplicateProducts] mediaInput count", mediaInput.length);
    const createJson = await shopify.graphql(PRODUCT_CREATE_MUTATION, {
      product: productInput,
      media: mediaInput.length ? mediaInput : undefined,
    });
    const errs = createJson?.productCreate?.userErrors ?? createJson?.errors ?? createJson?.data?.productCreate?.userErrors;
    if (errs && errs.length) {
      logger.error({ errs, productInput }, "productCreate failed");
      throw new Error(`Failed to create duplicate #${idx + 1}: ${errs.map((e: any) => e.message).join("; ")}`);
    }
  const created = createJson?.productCreate?.product ?? createJson?.data?.productCreate?.product;
    const newProductId: string | undefined = created?.id;
    if (!newProductId) throw new Error("productCreate returned no product id");
    console.log("[bulkDuplicateProducts] created product", newProductId);
    newProductIds.push(newProductId);

    // Replicate variants "as-is" (no images): build from base variants' selectedOptions and price
    const baseVariants: any[] = base.variants?.nodes ?? [];
    if (baseVariants.length > 0) {
      console.log("[bulkDuplicateProducts] replicating variants", baseVariants.length);
      // Map new product option names -> ids
      const optionIdByName = new Map<string, string>();
      for (const opt of created.options ?? []) {
        optionIdByName.set(opt.name, opt.id);
      }

      const variantsInput = baseVariants.map((bv) => ({
        price: bv.price != null ? String(bv.price) : undefined,
        optionValues: (bv.selectedOptions ?? []).map((so: any) => ({
          name: so.value,
          optionId: optionIdByName.get(so.name),
        })),
      }));
      console.log("[bulkDuplicateProducts] first variant input", variantsInput[0]);

      const vcJson = await shopify.graphql(VARIANTS_BULK_CREATE, {
        productId: newProductId,
        variants: variantsInput,
        strategy: "REMOVE_STANDALONE_VARIANT",
      });
      const vcErrs = vcJson?.productVariantsBulkCreate?.userErrors ?? vcJson?.errors ?? vcJson?.data?.productVariantsBulkCreate?.userErrors;
      if (vcErrs && vcErrs.length) {
        logger.error({ vcErrs }, "productVariantsBulkCreate failed");
      } else {
        console.log("[bulkDuplicateProducts] variants bulk create OK");
        // If a price override is specified, update the first created variant
        if (dup.price) {
          const createdVariants: any[] = vcJson?.productVariantsBulkCreate?.productVariants ?? vcJson?.data?.productVariantsBulkCreate?.productVariants ?? [];
          const firstVariantId = createdVariants[0]?.id;
          if (firstVariantId) {
            const priceStr = String(dup.price);
            const vbJson = await shopify.graphql(VARIANTS_BULK_UPDATE, {
              productId: newProductId,
              variants: [{ id: firstVariantId, price: priceStr }],
            });
            const vErrs = vbJson?.productVariantsBulkUpdate?.userErrors ?? vbJson?.errors ?? vbJson?.data?.productVariantsBulkUpdate?.userErrors;
            if (vErrs && vErrs.length) {
              logger.error({ vErrs }, "productVariantsBulkUpdate (override) failed");
            } else {
              console.log("[bulkDuplicateProducts] applied price override to first variant");
            }
          }
        }
      }
    } else {
      // No variants beyond the standalone one; apply price override to it if requested
      if (dup.price && created?.variants?.nodes?.[0]?.id) {
        const firstVariantId = created.variants.nodes[0].id as string;
        const priceStr = String(dup.price);
        const vbJson = await shopify.graphql(VARIANTS_BULK_UPDATE, {
          productId: newProductId,
          variants: [{ id: firstVariantId, price: priceStr }],
        });
        const vErrs = vbJson?.productVariantsBulkUpdate?.userErrors ?? vbJson?.errors ?? vbJson?.data?.productVariantsBulkUpdate?.userErrors;
        if (vErrs && vErrs.length) {
          logger.error({ vErrs }, "productVariantsBulkUpdate failed");
        } else {
          console.log("[bulkDuplicateProducts] applied price override to standalone variant");
        }
      }
    }

    // simple throttle to be polite with rate limits
    await delay(250);
    console.log("[bulkDuplicateProducts] throttle 250ms");
  }

  console.log("[bulkDuplicateProducts] done", { created: newProductIds.length });
  return {
    productIds: newProductIds,
    count: newProductIds.length,
  };
};
