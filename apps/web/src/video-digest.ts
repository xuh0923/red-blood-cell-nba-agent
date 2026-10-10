import { createSHA256 } from "hash-wasm";

const CHUNK_SIZE = 4 * 1024 * 1024;

export const calculateVideoDigest = async (
  file: Blob,
  onProgress?: (progress: number) => void
): Promise<string> => {
  const hash = await createSHA256();
  hash.init();
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    offset = end;
    onProgress?.(file.size ? offset / file.size : 1);
  }
  return `sha256:${hash.digest("hex")}`;
};
