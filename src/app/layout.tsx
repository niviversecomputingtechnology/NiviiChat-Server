import type { ReactNode } from "react";

export const metadata = {
  title: "NiviChat Backend",
  description: "NiviChat REST API"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
