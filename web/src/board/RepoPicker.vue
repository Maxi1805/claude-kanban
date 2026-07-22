<script setup lang="ts">
/**
 * RepoPicker — a thin wrapper over the reusable {@link FolderBrowser} in
 * "repos" mode, kept for backwards compatibility with existing call sites.
 *
 * It preserves the original emit contract (`add` / `add-many` / `cancel`) so
 * hosts that already speak it (CreateProjectModal) need no change, while the
 * actual browsing/selection UX now lives in the single shared FolderBrowser.
 */
import FolderBrowser from "@/board/FolderBrowser.vue";
import type { AddRepoDTO } from "@/types";

withDefaults(
  defineProps<{
    /** Seed the browser at this path (e.g. an existing repo's parent). */
    initialPath?: string | null;
    /** Surface a "Cerrar explorador" action that emits `cancel`. */
    closable?: boolean;
  }>(),
  { initialPath: null, closable: true },
);

const emit = defineEmits<{
  (e: "add", repo: AddRepoDTO): void;
  (e: "add-many", repos: AddRepoDTO[]): void;
  (e: "cancel"): void;
}>();
</script>

<template>
  <FolderBrowser
    mode="repos"
    :initial-path="initialPath"
    :closable="closable"
    @pick-repo="(r) => emit('add', r)"
    @pick-repos="(rs) => emit('add-many', rs)"
    @close="emit('cancel')"
  />
</template>
