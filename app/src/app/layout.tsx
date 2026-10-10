import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Code Reviewer",
  description: "Automatic code reviews for GitHub pull requests.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
