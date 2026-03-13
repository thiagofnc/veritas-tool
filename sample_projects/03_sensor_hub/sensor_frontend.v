module sensor_frontend (
    input wire clk,
    input wire rst,
    input wire enable,
    output wire sample_valid,
    output wire [11:0] sample_data,
    output wire filt_valid,
    output wire [11:0] filt_data
);
    wire [11:0] adc_data;
    wire adc_valid;

    adc_if u_adc_if (
        .clk(clk),
        .rst(rst),
        .enable(enable),
        .sample_valid(adc_valid),
        .sample_data(adc_data)
    );

    filter_stage u_filter_stage (
        .clk(clk),
        .rst(rst),
        .sample_valid(adc_valid),
        .sample_data(adc_data),
        .filt_valid(filt_valid),
        .filt_data(filt_data)
    );

    assign sample_valid = adc_valid;
    assign sample_data = adc_data;
endmodule
