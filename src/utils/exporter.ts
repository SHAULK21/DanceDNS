import JSZip from 'jszip';
import { RUST_PROJECT_FILES } from '../rust_code/sources';

export async function exportRustProjectZip(): Promise<void> {
  const zip = new JSZip();

  // Root directory folder in the zip
  const root = zip.folder('rusty-yoga-dns') || zip;

  for (const file of RUST_PROJECT_FILES) {
    root.file(file.path, file.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const downloadUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = 'rusty-yoga-dns-project.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);
}
