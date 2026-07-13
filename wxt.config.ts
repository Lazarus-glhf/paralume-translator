import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Paralume",
    short_name: "Paralume",
    description:
      "Read webpages with the original text and translation together.",
    permissions: ["activeTab", "scripting", "storage"],
    optional_host_permissions: ["https://*/*"],
  },
});
