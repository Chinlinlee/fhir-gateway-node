export type BundlePatients = {
    referencedPatients: ReadonlyArray<ReadonlySet<string>>;
    updatedPatients: ReadonlySet<string>;
    deletedPatients: ReadonlySet<string>;
    patientsToCreate: boolean;
};

export class BundlePatientsBuilder {
    private readonly referencedPatients: Array<Set<string>> = [];
    private readonly updatedPatients = new Set<string>();
    private readonly deletedPatients = new Set<string>();
    private patientsToCreate = false;

    addReferencedPatients(patientIds: Iterable<string>): void {
        this.referencedPatients.push(new Set(patientIds));
    }

    addPatient(operation: "READ" | "UPDATE", patientId: string): void {
        if (operation === "READ") {
            this.referencedPatients.push(new Set([patientId]));
        }
        if (operation === "UPDATE") {
            this.updatedPatients.add(patientId);
        }
    }

    addDeletedPatients(patientIds: Iterable<string>): void {
        for (const id of patientIds) {
            this.deletedPatients.add(id);
        }
        this.addReferencedPatients(patientIds);
    }

    setPatientCreationFlag(value: boolean): void {
        this.patientsToCreate = value;
    }

    build(): BundlePatients {
        return {
            referencedPatients: this.referencedPatients.map((s) => new Set(s)),
            updatedPatients: new Set(this.updatedPatients),
            deletedPatients: new Set(this.deletedPatients),
            patientsToCreate: this.patientsToCreate,
        };
    }
}
