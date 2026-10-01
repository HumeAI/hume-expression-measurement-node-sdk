// Maintained by hand and listed in .fernignore, so SDK regeneration leaves it in place.

// Each test loads the audio helpers anew, so each sees decibri installed or broken its own way.

async function openMicrophone(): Promise<unknown> {
    const { Microphone } = await import("../../src/audio-helpers/index");
    return Microphone.open();
}

describe("Microphone without a working decibri", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        delete (globalThis as { decibriLoadError?: Error }).decibriLoadError;
        vi.doUnmock("decibri");
    });

    function failToLoad(error: Error): void {
        (globalThis as { decibriLoadError?: Error }).decibriLoadError = error;
        vi.doMock("decibri");
    }

    it("names the install command when decibri is not installed", async () => {
        failToLoad(Object.assign(new Error("Cannot find module 'decibri'"), { code: "MODULE_NOT_FOUND" }));

        await expect(openMicrophone()).rejects.toMatchObject({
            name: "MissingDependencyError",
            message: expect.stringContaining("npm install decibri"),
        });
    });

    it("names the system library when decibri's native addon cannot load", async () => {
        failToLoad(new Error("Cannot find native binding. npm has a bug related to optional dependencies"));

        await expect(openMicrophone()).rejects.toMatchObject({
            name: "MissingDependencyError",
            message: expect.stringContaining("sudo apt-get install libasound2t64"),
        });
    });

    it("throws decibri's own error when it fails to load for another reason", async () => {
        const failure = new Error("Native binding package version mismatch, expected 5.7.0 but got 5.6.0.");
        failToLoad(failure);

        await expect(openMicrophone()).rejects.toBe(failure);
    });
});
