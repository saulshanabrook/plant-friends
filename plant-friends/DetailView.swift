//
//  SwiftUIView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//

import SwiftUI

struct DetailView: View {
    var plant: PFAFPlant
    
    var body: some View {
        //        ScrollView{
        VStack(alignment: .center) {
            Text(plant.latin_name)
                .font(.title)
            
            Text(plant.common_names_joined)
                .font(.subheadline)
                .foregroundColor(.secondary)
            
            
            List {
                Section(header: Text("Details")) {
                    ForEach(plant.tableFields) {
                        field in
                        HStack(alignment: .firstTextBaseline){
                            Text(field.id).bold()
                            Spacer()
                            Text(field.text)
                        }
                        
                    }
                }
                
                Section(header: Text("Descriptions")) {
                    ForEach(plant.detailFields) {
                        field in FieldView(field: field)
                    }
                }
                
            }.listStyle(.plain)
            
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(plant.latin_name)
                    .foregroundColor(Color("rw-dark"))
                    .fontWeight(.bold)
            }
        }
    }
}

struct DetailView_Previews: PreviewProvider {
    static var previews: some View {
        DetailView(plant: PFAFPlant.sample)
    }
}
