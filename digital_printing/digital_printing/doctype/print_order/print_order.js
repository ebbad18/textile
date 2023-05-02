// Copyright (c) 2023, ParaLogic and contributors
// For license information, please see license.txt

frappe.provide("erpnext.digital_printing");

erpnext.digital_printing.PrintOrder = class PrintOrder extends frappe.ui.form.Controller {

	conversion_factors = {
		inch_to_meter: 0.0254,
		yard_to_meter: 0.9144,
		meter_to_meter: 1
	}

	setup() {
		this.frm.custom_make_buttons = {
			'Sales Order': 'Sales Order',
			'Work Order': 'Work Order',
			'Packing Slip': 'Packing Slip',
			'Delivery Note': 'Delivery Note',
			'Sales Invoice': 'Sales Invoice',
		}

		this.setup_queries();
	}

	refresh() {
		erpnext.hide_company();
		this.setup_buttons();
		this.set_default_warehouse();
	}

	on_upload_complete() {
		this.frm.dirty();
		return this.get_items_from_attachments();
	}

	setup_queries() {
		this.frm.set_query("fabric_item", () => {
			let filters = {
				'print_item_type': 'Fabric',
			}
			if (this.frm.doc.is_fabric_provided_by_customer) {
				filters.customer = this.frm.doc.customer;
			}
			return erpnext.queries.item(filters);
		});

		this.frm.set_query("process_item", () => {
			return erpnext.queries.item({ print_item_type: 'Print Process' });
		});

		for (let warehouse_field of ["source_warehouse", "wip_warehouse", "fg_warehouse"]) {
			this.frm.set_query(warehouse_field, () => {
				return erpnext.queries.warehouse(this.frm.doc);
			});
		}
	}

	setup_buttons() {
		let doc = this.frm.doc;

		if (doc.docstatus == 1) {
			if (doc.items.filter(d => !d.item_code && !d.design_bom).length) {
				this.frm.add_custom_button(__('Items and BOMs'), () => this.create_design_items_and_boms(),
					__("Create"));
			} else if(flt(doc.per_ordered) < 100) {
				this.frm.add_custom_button(__('Sales Order'), () => this.make_sales_order(),
					__("Create"));
			}

			if (doc.per_ordered && doc.per_work_ordered < doc.per_ordered) {
				this.frm.add_custom_button(__('Work Order'), () => this.create_work_order(),
					__("Create"));
			}

			if (doc.per_produced && doc.per_packed < doc.per_produced && doc.per_delivered < 100) {
				this.frm.add_custom_button(__("Packing Slip"), () => this.make_packing_slip(),
					__("Create"));
			}

			if (doc.per_produced && doc.per_delivered < doc.per_produced
					&& (!doc.packing_slip_required || doc.per_delivered < doc.per_packed)
			) {
				this.frm.add_custom_button(__("Delivery Note"), () => this.make_delivery_note(),
					__("Create"));
			}

			if (doc.per_delivered && doc.per_billed < doc.per_delivered) {
				this.frm.add_custom_button(__("Sales Invoice"), () => this.make_sales_invoice(),
					__("Create"));
			}
		}
	}

	set_default_warehouse() {
		if (this.frm.is_new()) {
			const po_to_dps_warehouse_fn_map = {
				'source_warehouse': 'default_printing_source_warehouse',
				'wip_warehouse': 'default_printing_wip_warehouse',
				'fg_warehouse': 'default_printing_fg_warehouse',
			}

			for (let [po_warehouse_fn, dps_warehouse_fn] of Object.entries(po_to_dps_warehouse_fn_map)) {
				let warehouse = frappe.defaults.get_default(dps_warehouse_fn);
				if (!this.frm.doc[po_warehouse_fn] && warehouse) {
					this.frm.set_value(po_warehouse_fn, warehouse);
				}

			}
		}
	}

	customer() {
		this.get_order_defaults_from_customer();
	}

	default_gap() {
		this.override_default_value_in_items('design_gap');
	}

	default_qty() {
		this.override_default_value_in_items('qty');
	}

	default_uom() {
		this.override_default_value_in_items('uom');
		if (this.frm.doc.default_uom == "Panel") {
			this.frm.set_value("default_qty_type", "Print Qty");
		} else {
			this.frm.set_value("default_length_uom", this.frm.doc.default_uom);
		}
	}

	default_qty_type() {
		this.override_default_value_in_items('qty_type');
	}

	default_wastage() {
		this.override_default_value_in_items('per_wastage');
	}

	default_length_uom() {
		this.override_default_value_in_items('length_uom');
	}

	items_add(doc, cdt, cdn) {
		this.set_default_values_in_item(cdt, cdn);
	}

	items_remove() {
		this.calculate_totals();
	}

	before_items_remove(doc, cdt, cdn) {
		let row = frappe.get_doc(cdt, cdn);
		let file_name = this.frm.attachments.get_file_id_from_file_url(row.design_image);
		this.frm.attachments.remove_attachment(file_name);
		this.calculate_totals();
	}

	design_image(doc, cdt, cdn) {
		var me = this;
		let row = frappe.get_doc(cdt, cdn);

		return frappe.call({
			method: "get_image_details",
			args: {
				image_url: row.design_image
			},
			doc: me.frm.doc,
			callback: function(r) {
				if (!r.exc && r.message) {
					return frappe.model.set_value(cdt, cdn, r.message);
				}
			}
		});
	}

	design_gap() {
		this.calculate_totals();
	}

	qty() {
		this.calculate_totals();
	}

	uom(doc, cdt, cdn) {
		let row = frappe.get_doc(cdt, cdn);

		if (row.uom == 'Panel') {
			frappe.model.set_value(cdt, cdn, "qty_type", "Print Qty");
		} else {
			frappe.model.set_value(cdt, cdn, "length_uom", row.uom);
		}
		this.calculate_totals();
	}

	qty_type() {
		this.calculate_totals();
	}

	per_wastage() {
		this.calculate_totals();
	}

	length_uom() {
		this.calculate_totals();
	}

	get_order_defaults_from_customer() {
		if (!this.frm.doc.customer) return

		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.get_order_defaults_from_customer",
			args: {
				customer: this.frm.doc.customer
			},
			callback: (r) => {
				if (r.message) {
					this.frm.set_value(r.message);
				}
			}
		});
	}

	override_default_value_in_items(cdf) {
		(this.frm.doc.items || []).forEach(d => {
			this.set_default_values_in_item(d.doctype, d.name, cdf);
		});
	}

	set_default_values_in_item(cdt, cdn, cdf=null) {
		let defaults = {
			'design_gap': this.frm.doc.default_gap,
			'qty': this.frm.doc.default_qty,
			'uom': this.frm.doc.default_uom,	
			'qty_type': this.frm.doc.default_qty_type,
			'per_wastage': this.frm.doc.default_wastage,
			'length_uom': this.frm.doc.default_length_uom,
		}

		if (cdf) {
			if (defaults[cdf]) {
				frappe.model.set_value(cdt, cdn, cdf, defaults[cdf]);
			}
		} else {
			for (const [key, value] of Object.entries(defaults)) {
				if (value) {
					frappe.model.set_value(cdt, cdn, key, value);
				}
			}
		}
	}

	calculate_totals = () => {
		this.frm.doc.total_print_length = 0;
		this.frm.doc.total_fabric_length = 0;
		this.frm.doc.total_panel_qty = 0;

		this.frm.doc.items.forEach(d => {
			frappe.model.round_floats_in(d);

			d.panel_length_inch = flt(d.design_height) + flt(d.design_gap);
			d.panel_length_meter = d.panel_length_inch * this.conversion_factors.inch_to_meter;
			d.panel_length_yard = d.panel_length_meter / this.conversion_factors.yard_to_meter;

			let waste = d.per_wastage / 100;
			let uom_to_convert = d.length_uom + '_to_' + d.stock_uom;
			let conversion_factor = this.conversion_factors[uom_to_convert.toLowerCase()] || 1;

			if (d.uom != "Panel") {
				d.print_length = d.qty_type == "Print Qty" ? d.qty : waste < 1 ? d.qty * (1 - waste) : 0;
				d.fabric_length = d.qty_type == "Fabric Qty" ? d.qty : waste < 1 ? d.qty / (1 - waste) : 0;
			} else {
				d.print_length = d.qty * d.panel_length_meter / conversion_factor;
				d.fabric_length = waste < 1 ? d.print_length / (1 - waste) : 0;
			}
			d.print_length = flt(d.print_length, precision("print_length", d));
			d.fabric_length = flt(d.fabric_length, precision("print_length", d));

			d.stock_print_length = d.print_length * conversion_factor;
			d.stock_fabric_length = d.fabric_length * conversion_factor;

			d.panel_qty = d.panel_length_meter ? d.stock_print_length / d.panel_length_meter : 0;
			d.panel_qty = flt(d.panel_qty, precision("panel_qty", d));

			this.frm.doc.total_print_length += d.stock_print_length;
			this.frm.doc.total_fabric_length += d.stock_fabric_length;
			this.frm.doc.total_panel_qty += d.panel_qty;
		});

		this.frm.doc.total_print_length = flt(this.frm.doc.total_print_length, precision("total_print_length"));
		this.frm.doc.total_fabric_length = flt(this.frm.doc.total_fabric_length, precision("total_fabric_length"));
		this.frm.doc.total_panel_qty = flt(this.frm.doc.total_panel_qty, precision("total_panel_qty"));

		this.frm.debounced_refresh_fields();
	}

	get_items_from_attachments = frappe.utils.debounce(() => {
		var me = this;
		return frappe.call({
			method: "on_upload_complete",
			doc: me.frm.doc,
			callback: function(r) {
				if (!r.exc) {
					me.calculate_totals();
				}
			}
		});
	}, 1000);

	create_design_items_and_boms() {
		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.create_design_items_and_boms",
			args: {
				print_order: this.frm.doc.name
			},
			freeze: true,
			callback: (r) => {
				if (!r.exc) {
					this.frm.reload_doc();
				}
			}
		});
	}

	make_sales_order() {
		frappe.model.open_mapped_doc({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.make_sales_order",
			frm: this.frm
		});
	}

	create_work_order() {
		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.create_work_orders",
			args: {
				print_order: this.frm.doc.name
			},
			freeze: true,
			callback: (r) => {
				if (!r.exc) {
					this.frm.reload_doc();
				}
			}
		});
	}

	make_packing_slip() {
		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.make_packing_slip",
			args: {
				"print_order": this.frm.doc.name,
			},
			callback: function (r) {
				if (!r.exc) {
					var doclist = frappe.model.sync(r.message);
					frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
				}
			}
		});
	}

	make_delivery_note() {
		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.make_delivery_note",
			args: {
				"print_order": this.frm.doc.name,
			},
			callback: function (r) {
				if (!r.exc) {
					var doclist = frappe.model.sync(r.message);
					frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
				}
			}
		});
	}

	make_sales_invoice() {
		return frappe.call({
			method: "digital_printing.digital_printing.doctype.print_order.print_order.make_sales_invoice",
			args: {
				"print_order": this.frm.doc.name,
			},
			callback: function (r) {
				if (!r.exc) {
					var doclist = frappe.model.sync(r.message);
					frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
				}
			}
		});
	}
};

extend_cscript(cur_frm.cscript, new erpnext.digital_printing.PrintOrder({frm: cur_frm}));
