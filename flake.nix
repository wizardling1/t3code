{
  description = "T3 Code development shell";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # Prefer the repo's pinned vite-plus; fall back to npx so `vp i` can bootstrap
          # a fresh checkout. Its prebuilt binaries rely on programs.nix-ld.
          vp = pkgs.writeShellScriptBin "vp" ''
            root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
            if [ -x "$root/node_modules/.bin/vp" ]; then
              exec "$root/node_modules/.bin/vp" "$@"
            fi
            exec npx -y -p vite-plus@1.0.0 vp "$@"
          '';
          # npm's Electron (pinned newer than nixpkgs') runs through nix-ld and needs
          # these on its library path for `vp run dev:desktop`.
          electronLibraryPath = pkgs.lib.makeLibraryPath (
            with pkgs;
            [
              alsa-lib
              at-spi2-atk
              at-spi2-core
              atk
              cairo
              cups
              dbus
              expat
              glib
              gtk3
              libdrm
              libgbm
              libglvnd
              libnotify
              libsecret
              libx11
              libxcb
              libxcomposite
              libxdamage
              libxext
              libxfixes
              libxkbcommon
              libxrandr
              nspr
              nss
              pango
              systemd
              wayland
            ]
          );
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              vp
              # node-pty has no Linux prebuilds, so node-gyp compiles it.
              pkgs.python3
              # native/resource-monitor and the desktop browser-secret helper.
              pkgs.cargo
              pkgs.rustc
              pkgs.pkg-config
              pkgs.libsecret
            ];
            # Keep dev state in the checkout's gitignored .t3, away from the live ~/.t3,
            # matching the devcontainer. Linked worktrees already default to their own .t3.
            shellHook = ''
              export T3CODE_HOME="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.t3"
              # Load those libraries with their own glibc, not the (possibly older) system one.
              export NIX_LD="$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)"
              export NIX_LD_LIBRARY_PATH="${electronLibraryPath}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
            '';
          };
        }
      );
    };
}
