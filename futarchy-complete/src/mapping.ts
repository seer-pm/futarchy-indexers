import { Address, Bytes, BigInt, log, json, JSONValueKind } from "@graphprotocol/graph-ts"
import { AggregatorMetadataCreated } from "../generated/Creator/Creator"
import { OrganizationMetadataCreated } from "../generated/OrganizationFactory/OrganizationFactory"
import { ProposalMetadataCreated } from "../generated/ProposalMetadataFactory/ProposalMetadataFactory"
import { OrganizationAdded, OrganizationCreatedAndAdded, ExtendedMetadataUpdated as AggregatorExtendedMetadataUpdated, EditorSet as AggregatorEditorSet, EditorRevoked as AggregatorEditorRevoked, OrganizationRemoved, AggregatorInfoUpdated, OwnershipTransferred as AggregatorOwnershipTransferred } from "../generated/templates/AggregatorTemplate/Aggregator"
import { ProposalAdded, ProposalCreatedAndAdded, ExtendedMetadataUpdated as OrganizationExtendedMetadataUpdated, EditorSet as OrganizationEditorSet, EditorRevoked as OrganizationEditorRevoked, ProposalRemoved, CompanyInfoUpdated, OrganizationInfoUpdated, OwnershipTransferred as OrganizationOwnershipTransferred } from "../generated/templates/OrganizationTemplate/Organization"
import { MetadataUpdated, Proposal as MetadataContract, ExtendedMetadataUpdated as ProposalExtendedMetadataUpdated, OwnershipTransferred as ProposalOwnershipTransferred } from "../generated/templates/ProposalTemplate/Proposal"

import {
    ProposalEntity,
    Aggregator,
    Organization,
    MetadataEntry
} from "../generated/schema"

import {
    AggregatorTemplate,
    OrganizationTemplate,
    ProposalTemplate
} from "../generated/templates"

import { Aggregator as AggregatorContract } from "../generated/templates/AggregatorTemplate/Aggregator"
import { Organization as OrganizationContract } from "../generated/templates/OrganizationTemplate/Organization"

// ============================================
// FACTORY HANDLERS - Create entities when contracts are deployed
// ============================================

export function handleAggregatorCreated(event: AggregatorMetadataCreated): void {
    AggregatorTemplate.create(event.params.metadata)

    let entity = new Aggregator(event.params.metadata.toHexString())
    entity.name = event.params.name
    entity.creator = event.transaction.from
    entity.createdAt = event.block.timestamp

    let contract = AggregatorContract.bind(event.params.metadata)

    let dCall = contract.try_description()
    entity.description = dCall.reverted ? "" : dCall.value

    let mCall = contract.try_metadata()
    entity.metadata = mCall.reverted ? "" : mCall.value

    let uCall = contract.try_metadataURI()
    entity.metadataURI = uCall.reverted ? "" : uCall.value

    let oCall = contract.try_owner()
    entity.owner = oCall.reverted ? event.transaction.from : oCall.value
    entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
    updateMetadataEntries(entity.id, "Aggregator", entity.metadata)

    entity.save()
}

export function handleOrganizationMetadataCreated(event: OrganizationMetadataCreated): void {
    OrganizationTemplate.create(event.params.metadata)

    let orgId = event.params.metadata.toHexString()
    let entity = new Organization(orgId)
    entity.createdAt = event.block.timestamp
    entity.name = event.params.name

    let contract = OrganizationContract.bind(event.params.metadata)

    let dCall = contract.try_description()
    entity.description = dCall.reverted ? "" : dCall.value

    let oCall = contract.try_owner()
    entity.owner = oCall.reverted ? event.transaction.from : oCall.value

    let mCall = contract.try_metadata()
    entity.metadata = mCall.reverted ? "" : mCall.value

    let uCall = contract.try_metadataURI()
    entity.metadataURI = uCall.reverted ? "" : uCall.value
    entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
    updateMetadataEntries(entity.id, "Organization", entity.metadata)

    entity.save()
}

// KEY FIX: ID = metadata contract address, proposalAddress = trading contract
export function handleProposalMetadataCreated(event: ProposalMetadataCreated): void {
    let metadataAddr = event.params.metadata
    let proposalAddr = event.params.proposalAddress

    ProposalTemplate.create(metadataAddr)

    // ID is the METADATA contract address
    let entity = new ProposalEntity(metadataAddr.toHexString())
    entity.proposalAddress = proposalAddr  // Trading contract goes here
    entity.createdAtTimestamp = event.block.timestamp
    entity.title = "Loading..."
    entity.description = ""
    entity.displayNameEvent = ""
    entity.displayNameQuestion = ""

    let contract = MetadataContract.bind(metadataAddr)

    let qCall = contract.try_displayNameQuestion()
    if (!qCall.reverted) {
        entity.displayNameQuestion = qCall.value
        entity.title = qCall.value
    }

    let eCall = contract.try_displayNameEvent()
    if (!eCall.reverted) {
        entity.displayNameEvent = eCall.value
        if (entity.title == "Loading...") entity.title = eCall.value
    }

    let dCall = contract.try_description()
    entity.description = dCall.reverted ? "" : dCall.value

    let mCall = contract.try_metadata()
    entity.metadata = mCall.reverted ? "" : mCall.value
    entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
    updateMetadataEntries(entity.id, "Proposal", entity.metadata)

    let uCall = contract.try_metadataURI()
    entity.metadataURI = uCall.reverted ? "" : uCall.value

    let ownerCall = contract.try_owner()
    entity.owner = ownerCall.reverted ? null : ownerCall.value

    entity.save()
}

// ============================================
// AGGREGATOR TEMPLATE HANDLERS
// ============================================

export function handleOrganizationAdded(event: OrganizationAdded): void {
    let orgId = event.params.organizationMetadata.toHexString()
    let entity = Organization.load(orgId)

    if (entity == null) {
        OrganizationTemplate.create(event.params.organizationMetadata)
        entity = new Organization(orgId)
        entity.createdAt = event.block.timestamp
        entity.name = "Unknown"
        entity.description = ""
        entity.owner = event.transaction.from
    }

    entity.aggregator = event.address.toHexString()
    entity.save()
}

export function handleOrganizationCreatedAndAdded(event: OrganizationCreatedAndAdded): void {
    let orgId = event.params.organizationMetadata.toHexString()

    OrganizationTemplate.create(event.params.organizationMetadata)

    let entity = new Organization(orgId)
    entity.createdAt = event.block.timestamp
    entity.name = event.params.companyName
    entity.aggregator = event.address.toHexString()

    let contract = OrganizationContract.bind(event.params.organizationMetadata)

    let dCall = contract.try_description()
    entity.description = dCall.reverted ? "" : dCall.value

    let oCall = contract.try_owner()
    entity.owner = oCall.reverted ? event.transaction.from : oCall.value

    let eCall = contract.try_editor()
    entity.editor = eCall.reverted ? null : eCall.value

    let mCall = contract.try_metadata()
    entity.metadata = mCall.reverted ? "" : mCall.value

    let uCall = contract.try_metadataURI()
    entity.metadataURI = uCall.reverted ? "" : uCall.value
    entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
    updateMetadataEntries(entity.id, "Organization", entity.metadata)

    entity.save()
}

export function handleOrganizationRemoved(event: OrganizationRemoved): void {
    let entity = Organization.load(event.params.organizationMetadata.toHexString())
    if (entity != null) {
        entity.aggregator = null
        entity.save()
    }
}

export function handleAggregatorExtendedMetadataUpdated(event: AggregatorExtendedMetadataUpdated): void {
    let entity = Aggregator.load(event.address.toHexString())
    if (entity != null) {
        entity.metadata = event.params.metadata
        entity.metadataURI = event.params.metadataURI
        entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
        updateMetadataEntries(entity.id, "Aggregator", entity.metadata)
        entity.save()
    }
}

export function handleAggregatorEditorSet(event: AggregatorEditorSet): void {
    let entity = Aggregator.load(event.address.toHexString())
    if (entity != null) {
        entity.editor = event.params.newEditor
        entity.save()
    }
}

export function handleAggregatorEditorRevoked(event: AggregatorEditorRevoked): void {
    let entity = Aggregator.load(event.address.toHexString())
    if (entity != null) {
        entity.editor = null
        entity.save()
    }
}

// ============================================
// ORGANIZATION TEMPLATE HANDLERS
// ============================================

// ID = metadata address (proposalMetadata), link by metadata address
export function handleProposalAdded(event: ProposalAdded): void {
    let metadataAddr = event.params.proposalMetadata.toHexString()

    let entity = ProposalEntity.load(metadataAddr)
    if (entity != null) {
        entity.organization = event.address.toHexString()
        entity.save()
    }
}

export function handleProposalCreatedAndAdded(event: ProposalCreatedAndAdded): void {
    let metadataAddr = event.params.proposalMetadata
    let proposalAddr = event.params.proposalAddress

    ProposalTemplate.create(metadataAddr)

    // ID is the METADATA contract address
    let entity = new ProposalEntity(metadataAddr.toHexString())
    entity.proposalAddress = proposalAddr  // Trading contract
    entity.organization = event.address.toHexString()
    entity.createdAtTimestamp = event.block.timestamp
    entity.title = "Loading..."
    entity.description = ""
    entity.displayNameEvent = ""
    entity.displayNameQuestion = ""

    let contract = MetadataContract.bind(metadataAddr)

    let qCall = contract.try_displayNameQuestion()
    if (!qCall.reverted) {
        entity.displayNameQuestion = qCall.value
        entity.title = qCall.value
    }

    let eCall = contract.try_displayNameEvent()
    if (!eCall.reverted) {
        entity.displayNameEvent = eCall.value
        if (entity.title == "Loading...") entity.title = eCall.value
    }

    let dCall = contract.try_description()
    entity.description = dCall.reverted ? "" : dCall.value

    let mCall = contract.try_metadata()
    entity.metadata = mCall.reverted ? "" : mCall.value
    entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
    updateMetadataEntries(entity.id, "Proposal", entity.metadata)

    let uCall = contract.try_metadataURI()
    entity.metadataURI = uCall.reverted ? "" : uCall.value

    let ownerCall = contract.try_owner()
    entity.owner = ownerCall.reverted ? null : ownerCall.value

    entity.save()
}

export function handleProposalRemoved(event: ProposalRemoved): void {
    let entity = ProposalEntity.load(event.params.proposalMetadata.toHexString())
    if (entity != null) {
        entity.organization = null
        entity.save()
    }
}

export function handleOrganizationExtendedMetadataUpdated(event: OrganizationExtendedMetadataUpdated): void {
    let entity = Organization.load(event.address.toHexString())
    if (entity != null) {
        entity.metadata = event.params.metadata
        entity.metadataURI = event.params.metadataURI
        entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
        updateMetadataEntries(entity.id, "Organization", entity.metadata)
        entity.save()
    }
}

export function handleOrganizationEditorSet(event: OrganizationEditorSet): void {
    let entity = Organization.load(event.address.toHexString())
    if (entity != null) {
        entity.editor = event.params.newEditor
        entity.save()
    }
}

export function handleOrganizationEditorRevoked(event: OrganizationEditorRevoked): void {
    let entity = Organization.load(event.address.toHexString())
    if (entity != null) {
        entity.editor = null
        entity.save()
    }
}

// ============================================
// PROPOSAL TEMPLATE HANDLERS
// ============================================

export function handleProposalMetadataUpdated(event: MetadataUpdated): void {
    // event.address IS the metadata contract
    let entity = ProposalEntity.load(event.address.toHexString())
    if (entity != null) {
        entity.displayNameQuestion = event.params.displayNameQuestion
        entity.displayNameEvent = event.params.displayNameEvent
        entity.description = event.params.description

        if (event.params.displayNameQuestion.length > 0) {
            entity.title = event.params.displayNameQuestion
        } else {
            entity.title = event.params.displayNameEvent
        }

        entity.save()
    }
}

export function handleProposalExtendedMetadataUpdated(event: ProposalExtendedMetadataUpdated): void {
    // event.address IS the metadata contract
    let entity = ProposalEntity.load(event.address.toHexString())
    if (entity != null) {
        entity.metadata = event.params.metadata
        entity.metadataURI = event.params.metadataURI
        entity.metadataProperties = extractKeys(entity.metadata !== null ? changetype<string>(entity.metadata) : "")
        updateMetadataEntries(entity.id, "Proposal", entity.metadata)
        entity.save()
    }
}

// ============================================
// HELPERS
// ============================================

function extractKeys(metadata: string): string[] {
    if (metadata.length == 0) return []

    // Try parsing JSON
    let result = json.try_fromString(metadata)
    if (result.isError) return []

    // Ensure it is an object
    if (result.value.kind != JSONValueKind.OBJECT) return []

    let jsonObj = result.value.toObject()
    let entries = jsonObj.entries
    let keys: string[] = []

    for (let i = 0; i < entries.length; i++) {
        keys.push(entries[i].key)
    }

    return keys
}

function updateMetadataEntries(parentId: string, parentType: string, metadata: string | null): void {
    if (metadata === null) return
    if (metadata.length == 0) return

    let result = json.try_fromString(metadata)
    if (result.isError) return
    if (result.value.kind != JSONValueKind.OBJECT) return

    let jsonObj = result.value.toObject()
    let entries = jsonObj.entries

    for (let i = 0; i < entries.length; i++) {
        let key = entries[i].key
        let value = entries[i].value
        let strValue = ""

        // Simpification: Convert everything to string for indexing
        if (value.kind == JSONValueKind.STRING) {
            strValue = value.toString()
        } else if (value.kind == JSONValueKind.NUMBER) {
            strValue = value.toF64().toString()
        } else if (value.kind == JSONValueKind.BOOL) {
            strValue = value.toBool() ? "true" : "false"
        } else {
            // Nested objects/arrays ignored for value indexing in this version
            continue
        }

        let entryId = parentId + "-" + key
        let entry = new MetadataEntry(entryId)
        entry.key = key
        entry.value = strValue

        if (parentType == "Aggregator") {
            entry.aggregator = parentId
        } else if (parentType == "Organization") {
            entry.organization = parentId
        } else if (parentType == "Proposal") {
            entry.proposal = parentId
        }

        entry.save()
    }
}

// ============================================
// INFO + OWNERSHIP HANDLERS
// Name/description edits and owner transfers were never wired up, so those
// three fields kept whatever value they had at creation time. The entities
// already carried them, which is why the staleness was invisible.
// ============================================

export function handleAggregatorInfoUpdated(event: AggregatorInfoUpdated): void {
    let entity = Aggregator.load(event.address.toHexString())
    if (entity != null) {
        entity.name = event.params.newName
        entity.description = event.params.newDescription
        entity.save()
    }
}

export function handleAggregatorOwnershipTransferred(event: AggregatorOwnershipTransferred): void {
    let entity = Aggregator.load(event.address.toHexString())
    if (entity != null) {
        entity.owner = event.params.newOwner
        entity.save()
    }
}

// The org "info changed" event was renamed CompanyInfoUpdated ->
// OrganizationInfoUpdated across contract versions. Different names hash to
// different topics, so both are indexed and share this body; whichever the
// deployed org emits wins, and the other simply never fires.
function applyOrganizationInfo(orgAddress: string, newName: string, newDescription: string): void {
    let entity = Organization.load(orgAddress)
    if (entity != null) {
        entity.name = newName
        entity.description = newDescription
        entity.save()
    }
}

export function handleCompanyInfoUpdated(event: CompanyInfoUpdated): void {
    applyOrganizationInfo(event.address.toHexString(), event.params.newName, event.params.newDescription)
}

export function handleOrganizationInfoUpdated(event: OrganizationInfoUpdated): void {
    applyOrganizationInfo(event.address.toHexString(), event.params.newName, event.params.newDescription)
}

export function handleOrganizationOwnershipTransferred(event: OrganizationOwnershipTransferred): void {
    let entity = Organization.load(event.address.toHexString())
    if (entity != null) {
        entity.owner = event.params.newOwner
        entity.save()
    }
}

export function handleProposalOwnershipTransferred(event: ProposalOwnershipTransferred): void {
    let entity = ProposalEntity.load(event.address.toHexString())
    if (entity != null) {
        entity.owner = event.params.newOwner
        entity.save()
    }
}
