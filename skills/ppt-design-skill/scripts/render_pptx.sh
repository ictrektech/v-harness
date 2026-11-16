#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    printf '%s\n' 'Usage: render_pptx.sh <file.pptx> <new-preview-directory>' >&2
    exit 2
fi

source=$(realpath -e -- "$1")
output=$2
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

libreoffice "-env:UserInstallation=file://$scratch/profile" --headless \
    --convert-to pdf --outdir "$scratch" "$source"
pdf="$scratch/$(basename -- "$source" .pptx).pdf"
pdftoppm -png -r 144 "$pdf" "$scratch/slide"
mkdir -- "$output"
cp -- "$pdf" "$scratch"/slide-*.png "$output/"
