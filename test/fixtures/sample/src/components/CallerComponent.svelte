<script lang="ts">
  // This .svelte file isn't compiled by deadlint's TS project loader,
  // but the dead-rpc check should still see the string-key dispatch here
  // and keep `frontendOnlyMethod` alive.
  //
  // Without companion-file scanning, ServerDO.frontendOnlyMethod would
  // appear dead because the only caller in the entire project lives
  // outside .ts files.

  declare const client: {
    call: <R = unknown>(method: string, args: unknown[]) => Promise<R>;
  };

  async function trigger() {
    return await client.call<string>("frontendOnlyMethod", ["payload"]);
  }
</script>

<button on:click={trigger}>Trigger</button>
