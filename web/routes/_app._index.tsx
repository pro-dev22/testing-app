import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Box,
  Text,
  Button,
  TextField,
  InlineGrid,
  InlineStack,
  Banner,
  Divider,
  Checkbox,
  DropZone,
  LegacyStack,
  Tag,
  Spinner,
  Tabs,
  Modal,
  Icon,
} from "@shopify/polaris";

import { useAppBridge } from "@shopify/app-bridge-react";
import { api } from "../api";

type SelectedProduct = {
  id: string; // gid://shopify/Product/xxx
  title?: string;
  handle?: string;
  status?: string;
  collections?: any[];
  metafields?: any[];
  inventory?: any[];
  description?: string;
  vendor?: string;
  productType?: string;
  price?: string;
  tags?: string[] | string;
};

type DuplicateRow = {
  title: string;
  imageFiles: File[]; // replace all images
  imageUrls: string[]; // optional external URLs
  tempUrl?: string; // helper for URL input
  descriptionHtml?: string;
  vendor?: string;
  tags?: string;
  productType?: string;
  price?: string;
};

export const loader = async ({ context }: LoaderFunctionArgs) => {
  return json({ gadgetConfig: context.gadgetConfig });
};

// No server-side action yet; backend will be wired later
export const action = async (_args: ActionFunctionArgs) => {
  return json({ ok: true });
};

export default function DuplicatePage() {
  const { gadgetConfig } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [selectedProduct, setSelectedProduct] = useState<SelectedProduct | null>(null);
  const [picking, setPicking] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [activeModalRow, setActiveModalRow] = useState<number | null>(null);

  // field selection
  const [fields, setFields] = useState({
    title: true,
    images: true,
    descriptionHtml: false,
    vendor: false,
    tags: false,
    productType: false,
    price: false,
  });

  const [quantity, setQuantity] = useState("1");
  const qty = Math.max(1, Number.isFinite(Number(quantity)) ? Number(quantity) : 1);

  const [rows, setRows] = useState<DuplicateRow[]>([{ title: "", imageFiles: [], imageUrls: [] }]);
  const [createdLinks, setCreatedLinks] = useState<string[] | null>(null);

  useEffect(() => {
    // ensure rows length matches quantity
    setRows((prev) => {
      const next = [...prev];
      while (next.length < qty) next.push({ title: "", imageFiles: [], imageUrls: [] });
      while (next.length > qty) next.pop();
      return next;
    });
  }, [qty]);

  const handlePickProduct = async () => {
    setPicking(true);
    try {
      // Resource Picker v4 via shopify.resourcePicker
      const selected = await shopify.resourcePicker({ type: "product", multiple: false, action: "select" });
      if (selected && selected.length > 0) {
        const prod = selected[0] as any;
        console.log(`[duplicate/ui] picked product`, prod);
        const rawId: string = prod?.id ?? prod?.gid ?? prod?.resourceId ?? "";
        if (typeof rawId === "string" && rawId.includes("/ProductVariant/")) {
          shopify.toast.show("Please pick a product, not a variant");
          setSelectedProduct(null);
          return;
        }
                 const gid = rawId?.startsWith("gid://") ? rawId : `gid://shopify/Product/${rawId}`;
         setSelectedProduct({ id: gid, title: prod?.title, status: prod?.status, collections: prod?.collections, metafields: prod?.metafields, inventory: prod?.inventory, description: prod?.description, vendor: prod?.vendor, productType: prod?.productType, price: prod?.price });
         
                   // Pre-populate the first row with the selected product's data for easy modification
          if (prod) {
            setRows([{
              title: prod.title || "",
              imageFiles: [],
              imageUrls: [],
              descriptionHtml: prod.descriptionHtml || prod.description || "",
              vendor: prod.vendor || "",
              tags: Array.isArray(prod.tags) ? prod.tags.join(", ") : prod.tags || "",
              productType: prod.productType || "",
              price: prod.price || prod.variants?.[0]?.price || "",
            }]);
          }
      }
    } catch (err) {
      console.error("[duplicate/ui] picker error", err);
    } finally {
      setPicking(false);
    }
  };

  const updateRow = (index: number, patch: Partial<DuplicateRow>) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const removeFileAt = (i: number, fi: number) => {
    setRows((prev) => {
      const next = [...prev];
      const files = [...next[i].imageFiles];
      files.splice(fi, 1);
      next[i].imageFiles = files;
      return next;
    });
  };

  const removeUrlAt = (i: number, ui: number) => {
    setRows((prev) => {
      const next = [...prev];
      const urls = [...next[i].imageUrls];
      urls.splice(ui, 1);
      next[i].imageUrls = urls;
      return next;
    });
  };

  const canSubmit = Boolean(selectedProduct) && rows.every((r) => !fields.title || r.title.trim().length > 0);

  const uploadImagesIfNeeded = async () => {
    console.debug("[duplicate/ui] uploadImagesIfNeeded start");
    const allFiles: { i: number; file: File }[] = [];
    rows.forEach((r, i) => r.imageFiles.forEach((file) => allFiles.push({ i, file })));
    if (allFiles.length === 0) return [] as { i: number; urls: string[] }[];

    const reqFiles = allFiles.map(({ file }) => ({ filename: file.name, mimeType: file.type || "image/jpeg", size: file.size }));
    const client: any = api as any;
    console.debug("[duplicate/ui] requesting staged targets", reqFiles.map((f) => ({ name: f.filename, type: f.mimeType, size: f.size })));
    const prepRes = client.prepareImageUploads?.run
      ? await client.prepareImageUploads.run({ files: reqFiles })
      : typeof client.prepareImageUploads === "function"
        ? await client.prepareImageUploads({ files: reqFiles })
        : await Promise.reject(new Error("prepareImageUploads action not available in client"));
    const targets: any[] = prepRes?.targets ?? [];
    console.debug("[duplicate/ui] staged targets received", targets.length);
    if (targets.length !== allFiles.length) throw new Error("Staged uploads count mismatch");

    const perRowUrls: { i: number; urls: string[] }[] = rows.map((_r, i) => ({ i, urls: [] }));
    await Promise.all(
      targets.map(async (t, idx) => {
        const { i, file } = allFiles[idx];
        const form = new FormData();
        for (const p of t.parameters) form.append(p.name, p.value);
        form.append("file", file, file.name);
        const resp = await fetch(t.url, { method: "POST", body: form });
        if (!resp.ok && resp.status !== 201) {
          const text = await resp.text().catch(() => "");
          throw new Error(`Upload failed (${resp.status}) ${text}`);
        }
        perRowUrls[i].urls.push(t.resourceUrl);
      })
    );

    console.debug("[duplicate/ui] uploads complete", perRowUrls);
    return perRowUrls;
  };

  const onSubmit = async () => {
    if (!selectedProduct) return;
    setIsSubmitting(true);
    console.debug("[duplicate/ui] onSubmit clicked", { hasProduct: Boolean(selectedProduct), rowCount: rows.length, fields });
    let stagedByRow: { i: number; urls: string[] }[] = [];
    try {
      console.debug("[duplicate/ui] staging local images if present");
      stagedByRow = await uploadImagesIfNeeded();
    } catch (e: any) {
      shopify.toast.show(`Image upload error: ${e?.message ?? e}`);
      return;
    }
    console.debug("[duplicate/ui] building payload", { selectedProduct, rowsCount: rows.length, stagedRows: stagedByRow.length });
    
    // Check if any fields are selected for customization
    const hasCustomFields = Object.values(fields).some(Boolean);
    
    const payload = {
      sourceProductId: selectedProduct.id?.startsWith("gid://") ? selectedProduct.id : `gid://shopify/Product/${selectedProduct.id}`,
      duplicates: rows.map((r, ri) => {
        // If no fields are selected, send empty object to use all original data
        if (!hasCustomFields) {
          return {};
        }
        
        // Otherwise, only include fields that are selected for customization
        const duplicateData: any = {};
        
        if (fields.title && r.title?.trim()) {
          duplicateData.title = r.title.trim();
        }
        
        if (fields.images) {
          const imageUrls = [
            ...((stagedByRow.find((x) => ri === x.i)?.urls) ?? []),
            ...(r.imageUrls ?? []),
          ];
          if (imageUrls.length > 0) {
            duplicateData.imageUrls = imageUrls;
          }
        }
        
        if (fields.descriptionHtml && r.descriptionHtml?.trim()) {
          duplicateData.descriptionHtml = r.descriptionHtml.trim();
        }
        
        if (fields.vendor && r.vendor?.trim()) {
          duplicateData.vendor = r.vendor.trim();
        }
        
        if (fields.tags && r.tags?.trim()) {
          duplicateData.tags = r.tags.split(",").map((t) => t.trim()).filter(Boolean);
        }
        
        if (fields.productType && r.productType?.trim()) {
          duplicateData.productType = r.productType.trim();
        }
        
                   if (fields.price && r.price?.trim()) {
            duplicateData.price = r.price.trim();
          }
          
          return duplicateData;
      }),
    };

    console.debug("[duplicate/ui] submitting payload", payload);
    console.log("[duplicate/ui] submitting payload", payload);
    console.log("[duplicate/ui] payload details:", {
      sourceProductId: payload.sourceProductId,
      duplicatesCount: payload.duplicates.length,
      hasCustomFields,
      firstDuplicate: payload.duplicates[0]
    });
    try {
      const client: any = api as any;
      const result = client.bulkDuplicateProducts?.run
        ? await client.bulkDuplicateProducts.run(payload)
        : typeof client.bulkDuplicateProducts === "function"
          ? await client.bulkDuplicateProducts(payload)
          : await Promise.reject(new Error("bulkDuplicateProducts action not available in client"));
      const ids: string[] = result.productIds ?? [];
      console.debug("[duplicate/ui] backend result ids", ids);
      console.log("[duplicate/ui] backend result ids", ids);
      if (ids.length) {
        const adminPaths = ids.map((gid) => {
          const num = gid.split("/").pop();
          return `shopify://admin/products/${num}`;
        });
        shopify.toast.show(`${ids.length} product${ids.length > 1 ? "s" : ""} created`);
        setCreatedLinks(adminPaths);
      } else {
        shopify.toast.show("No products created");
      }
    } catch (e: any) {
      console.error("[duplicate/ui] submit error", e);
      shopify.toast.show(`Error: ${e?.message ?? "Failed to duplicate"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenModal = (index: number) => {
    setActiveModalRow(index);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setActiveModalRow(null);
  };

  const modalRow = activeModalRow !== null ? rows[activeModalRow] : null;

  return (
    <Page title="Duplicate products">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {createdLinks && createdLinks.length > 0 && (
              <Banner title={`Created ${createdLinks.length} product${createdLinks.length > 1 ? "s" : ""}`} tone="success">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">Open in Admin:</Text>
                  <LegacyStack wrap spacing="tight">
                    {createdLinks.map((u, i) => (
                      <a key={i} href={u} target="_top" rel="noreferrer">Product #{i + 1}</a>
                    ))}
                  </LegacyStack>
                </BlockStack>
              </Banner>
            )}

            {/* Step 1: Select Source Product */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingLg">1. Pick a source product</Text>
                <Divider />
                <InlineStack gap="200" align="start">
                  <Button variant="primary" onClick={handlePickProduct} disabled={picking} loading={picking}>
                    Pick product
                  </Button>
                  {selectedProduct && (
                    <InlineStack gap="200" align="center">
                      <Text as="span" variant="bodyMd">Selected:</Text>
                      <Tag onRemove={() => setSelectedProduct(null)}>{selectedProduct.title ?? selectedProduct.id}</Tag>
                    </InlineStack>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Step 2 & 3: Configure and Create, only visible after a product is selected */}
            {selectedProduct && (
              <>
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">2. Configure duplicates</Text>
                    <Divider />
                    <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">Fields to customize</Text>
                        <BlockStack gap="100">
                          <Checkbox label="Title" checked={fields.title} onChange={(v) => setFields((f) => ({ ...f, title: v }))} />
                          <Checkbox label="Images (replace all)" checked={fields.images} onChange={(v) => setFields((f) => ({ ...f, images: v }))} />
                          <Checkbox label="Description" checked={fields.descriptionHtml} onChange={(v) => setFields((f) => ({ ...f, descriptionHtml: v }))} />
                          <Checkbox label="Vendor" checked={fields.vendor} onChange={(v) => setFields((f) => ({ ...f, vendor: v }))} />
                          <Checkbox label="Tags (comma separated)" checked={fields.tags} onChange={(v) => setFields((f) => ({ ...f, tags: v }))} />
                          <Checkbox label="Product type" checked={fields.productType} onChange={(v) => setFields((f) => ({ ...f, productType: v }))} />
                                                     <Checkbox label="Price (initial variant)" checked={fields.price} onChange={(v) => setFields((f) => ({ ...f, price: v }))} />
                        </BlockStack>
                        {!Object.values(fields).some(Boolean) && (
                          <Banner tone="info">
                            <Text as="p" variant="bodyMd">
                              No fields selected for customization. Products will be duplicated with all original data.
                            </Text>
                          </Banner>
                        )}
                                                 <Banner tone="success">
                           <Text as="p" variant="bodyMd">
                             <strong>Inventory Note:</strong> All duplicated products will inherit the inventory settings from the source product.
                           </Text>
                         </Banner>
                      </BlockStack>
                      <BlockStack gap="300">
                        <Text as="h3" variant="headingMd">Quantity</Text>
                        <TextField
                          type="number"
                          label="Number of duplicates"
                          autoComplete="off"
                          value={quantity}
                          min={1}
                          onChange={(v) => setQuantity(v)}
                        />
                      </BlockStack>
                    </InlineGrid>
                  </BlockStack>
                </Card>

                {/* Dynamic List for Duplicates with Modal Editing */}
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingLg">3. Customize each duplicate</Text>
                    <Divider />
                    <BlockStack gap="200">
                      {rows.map((row, i) => (
                        <div key={i}>
                          <InlineStack align="space-between" blockAlign="center">
                            <Text as="h3" variant="bodyLg">Duplicate #{i + 1} {row.title && <Text as="span" variant="bodyMd" tone="subdued">({row.title})</Text>}</Text>
                            <Button onClick={() => handleOpenModal(i)}>
                              Edit
                            </Button>
                          </InlineStack>
                          {i < rows.length - 1 && <Divider />}
                        </div>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>

                {/* Final Submit Button */}
                <Box paddingBlockStart="400">
                  <InlineStack align="end">
                    <Button
                      variant="primary"
                      disabled={!canSubmit || isSubmitting}
                      loading={isSubmitting}
                      onClick={onSubmit}
                    >
                      {isSubmitting ? "Creating products..." : `Create ${qty} duplicate${qty > 1 ? "s" : ""}${!Object.values(fields).some(Boolean) ? " (exact copy)" : ""}`}
                    </Button>
                  </InlineStack>
                </Box>
              </>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      {/* Modal for editing a specific row */}
      {showModal && activeModalRow !== null && modalRow && (
        <Modal
          open={showModal}
          onClose={handleCloseModal}
          title={`Edit Duplicate #${activeModalRow + 1}`}
          primaryAction={{
            content: "Done",
            onAction: handleCloseModal,
          }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {selectedProduct && (
                <InlineStack align="end">
                  <Button
                    variant="plain"
                    onClick={() => {
                      if (selectedProduct) {
                                                                                                   updateRow(activeModalRow, {
                            title: selectedProduct.title || "",
                            descriptionHtml: selectedProduct.description || "",
                            vendor: selectedProduct.vendor || "",
                            tags: Array.isArray(selectedProduct.tags) ? selectedProduct.tags.join(", ") : selectedProduct.tags || "",
                            productType: selectedProduct.productType || "",
                            price: selectedProduct.price || "",
                          });
                      }
                    }}
                  >
                    Reset to Original
                  </Button>
                </InlineStack>
              )}
              {fields.title && (
                <TextField label="New product title" value={modalRow.title ?? ""} onChange={(v) => updateRow(activeModalRow, { title: v })} autoComplete="off" />
              )}
              {fields.descriptionHtml && (
                <TextField label="Description (HTML allowed)" value={modalRow.descriptionHtml ?? ""} onChange={(v) => updateRow(activeModalRow, { descriptionHtml: v })} autoComplete="off" multiline={4} />
              )}
              {fields.vendor && (
                <TextField label="Vendor" value={modalRow.vendor ?? ""} onChange={(v) => updateRow(activeModalRow, { vendor: v })} autoComplete="off" />
              )}
              {fields.tags && (
                <TextField label="Tags (comma separated)" value={modalRow.tags ?? ""} onChange={(v) => updateRow(activeModalRow, { tags: v })} autoComplete="off" />
              )}
                                            {fields.productType && (
                 <TextField label="Product type" value={modalRow.productType ?? ""} onChange={(v) => updateRow(activeModalRow, { productType: v })} autoComplete="off" />
               )}
               {fields.price && (
                 <TextField type="number" label="Price" value={modalRow.price ?? ""} onChange={(v) => updateRow(activeModalRow, { price: v })} autoComplete="off" />
               )}
               
              {fields.images && (
                <BlockStack gap="200">
                  <Text as="h4" variant="headingSm">Replacement images</Text>
                  <DropZone
                    allowMultiple
                    onDrop={(_files, acceptedFiles) => {
                      const accepted = acceptedFiles.filter((f) => f.type.startsWith("image/"));
                      updateRow(activeModalRow, { imageFiles: [...modalRow.imageFiles, ...accepted] });
                    }}
                    type="image"
                  >
                    <DropZone.FileUpload actionTitle="Add images" actionHint="PNG, JPG, GIF, WEBP" />
                  </DropZone>
                  <LegacyStack wrap spacing="tight">
                    {modalRow.imageFiles.map((f, fi) => (<Tag key={fi} onRemove={() => removeFileAt(activeModalRow, fi)}>{f.name}</Tag>))}
                    {modalRow.imageUrls.map((u, ui) => (<Tag key={ui} onRemove={() => removeUrlAt(activeModalRow, ui)}>{u}</Tag>))}
                  </LegacyStack>
                  <InlineStack gap="200" align="start">
                    <TextField label="Or add image URL" autoComplete="off" value={modalRow.tempUrl ?? ""} onChange={(v) => updateRow(activeModalRow, { tempUrl: v })} />
                    <Button onClick={() => {
                      const v = (modalRow.tempUrl ?? "").trim();
                      if (!v) return;
                      updateRow(activeModalRow, { imageUrls: [...modalRow.imageUrls, v], tempUrl: "" });
                    }}
                    >Add URL</Button>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}