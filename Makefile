.PHONY: install clean

bin/webm-convert: mod.ts
	deno compile -o ./bin/webm-convert --allow-read --allow-write --allow-run --allow-env --allow-net ./mod.ts

install: mod.ts
	deno install -c deno.json -f --allow-read --allow-write --allow-run --allow-env --allow-net ./mod.ts

clean:
	rm -rf ./bin sample sample_2
